import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { getRefundEligibility } from "./refunds.server";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Local times, so the calendar-day arithmetic is the same in every timezone.
const PURCHASED_AT = "2026-03-01T10:00:00";
const LAST_DAY_OF_WINDOW = new Date("2026-03-15T23:00:00");
const DAY_AFTER_WINDOW = new Date("2026-03-16T00:30:00");
const INSIDE_WINDOW = new Date("2026-03-05T12:00:00");

describe("getRefundEligibility", () => {
  let base: ReturnType<typeof seedBaseData>;
  let lessonIds: number[];

  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);

    testDb
      .update(schema.courses)
      .set({ price: 7900 })
      .where(eq(schema.courses.id, base.course.id))
      .run();

    const mod = testDb
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "Module 1", position: 1 })
      .returning()
      .get();

    lessonIds = [1, 2, 3, 4].map(
      (position) =>
        testDb
          .insert(schema.lessons)
          .values({ moduleId: mod.id, title: `Lesson ${position}`, position })
          .returning()
          .get().id
    );
  });

  function buyCourse(amountPaid = 5000) {
    return testDb
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid,
        createdAt: PURCHASED_AT,
      })
      .returning()
      .get();
  }

  function completeLessons(count: number) {
    testDb
      .insert(schema.lessonProgress)
      .values(
        lessonIds.slice(0, count).map((lessonId) => ({
          userId: base.user.id,
          lessonId,
          status: schema.LessonProgressStatus.Completed,
        }))
      )
      .run();
  }

  function watch(lessonId: number, positionSeconds: number) {
    testDb
      .insert(schema.videoWatchEvents)
      .values({
        userId: base.user.id,
        lessonId,
        eventType: "progress",
        positionSeconds,
      })
      .run();
  }

  it("is eligible inside the Refund Window with little of the course used", () => {
    const purchase = buyCourse();
    completeLessons(1);

    const result = getRefundEligibility(
      base.user.id,
      base.course.id,
      INSIDE_WINDOW
    );

    expect(result).toEqual({
      eligible: true,
      purchase,
      refundableAmount: 5000,
      lastDayOfRefundWindow: "2026-03-15",
    });
  });

  it("refunds the amount paid, not the course's current list price", () => {
    buyCourse(2500);

    const result = getRefundEligibility(
      base.user.id,
      base.course.id,
      INSIDE_WINDOW
    );

    expect(result).toMatchObject({ eligible: true, refundableAmount: 2500 });
  });

  it("is not eligible without a Purchase", () => {
    expect(
      getRefundEligibility(base.user.id, base.course.id, INSIDE_WINDOW)
    ).toEqual({ eligible: false, reason: "no_purchase" });
  });

  it("is not eligible while a Refund Request is Requested", () => {
    const purchase = buyCourse();
    testDb
      .insert(schema.refundRequests)
      .values({ purchaseId: purchase.id, reason: "Not what I expected." })
      .run();

    expect(
      getRefundEligibility(base.user.id, base.course.id, INSIDE_WINDOW)
    ).toEqual({ eligible: false, reason: "already_requested" });
  });

  it("is eligible again after an earlier Refund Request was Declined", () => {
    const purchase = buyCourse();
    testDb
      .insert(schema.refundRequests)
      .values({
        purchaseId: purchase.id,
        reason: "Not what I expected.",
        status: schema.RefundRequestStatus.Declined,
      })
      .run();

    expect(
      getRefundEligibility(base.user.id, base.course.id, INSIDE_WINDOW)
    ).toMatchObject({ eligible: true });
  });

  it("is not eligible for a claimed team seat", () => {
    const purchase = buyCourse();
    const team = testDb.insert(schema.teams).values({}).returning().get();
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        code: "SEAT-1",
        purchaseId: purchase.id,
        redeemedByUserId: base.user.id,
        redeemedAt: PURCHASED_AT,
      })
      .run();

    expect(
      getRefundEligibility(base.user.id, base.course.id, INSIDE_WINDOW)
    ).toEqual({ eligible: false, reason: "claimed_team_seat" });
  });

  it("counts the whole of the last day of the Refund Window", () => {
    buyCourse();

    expect(
      getRefundEligibility(base.user.id, base.course.id, LAST_DAY_OF_WINDOW)
    ).toMatchObject({ eligible: true });
  });

  it("is not eligible once the Refund Window has closed", () => {
    buyCourse();

    expect(
      getRefundEligibility(base.user.id, base.course.id, DAY_AFTER_WINDOW)
    ).toEqual({ eligible: false, reason: "window_closed" });
  });

  it("is not eligible after completing half of the lessons", () => {
    buyCourse();
    completeLessons(2);

    expect(
      getRefundEligibility(base.user.id, base.course.id, INSIDE_WINDOW)
    ).toEqual({ eligible: false, reason: "completed_too_much" });
  });

  it("is not eligible after watching two hours, counting the furthest point per lesson", () => {
    buyCourse();
    watch(lessonIds[0], 1800);
    watch(lessonIds[0], 3600);
    watch(lessonIds[1], 3600);

    expect(
      getRefundEligibility(base.user.id, base.course.id, INSIDE_WINDOW)
    ).toEqual({ eligible: false, reason: "watched_too_much" });
  });
});

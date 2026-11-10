import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refundRequests,
  videoWatchEvents,
  LessonProgressStatus,
  RefundRequestStatus,
} from "~/db/schema";

export const REFUND_WINDOW_DAYS = 14;
const WATCH_LIMIT_SECONDS = 2 * 60 * 60;
const COMPLETION_LIMIT = 0.5;

type Purchase = typeof purchases.$inferSelect;

export type RefundIneligibleReason =
  | "no_purchase"
  | "already_requested"
  | "claimed_team_seat"
  | "window_closed"
  | "watched_too_much"
  | "completed_too_much";

export type RefundEligibility =
  | {
      eligible: true;
      purchase: Purchase;
      refundableAmount: number;
      lastDayOfRefundWindow: string;
    }
  | { eligible: false; reason: RefundIneligibleReason };

function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

function hasRequestedRefundRequest(purchaseId: number) {
  const row = db
    .select({ id: refundRequests.id })
    .from(refundRequests)
    .where(
      and(
        eq(refundRequests.purchaseId, purchaseId),
        eq(refundRequests.status, RefundRequestStatus.Requested)
      )
    )
    .get();

  return row !== undefined;
}

// A seat that came out of a team licence, and has been claimed, belongs to
// the team — the learner cannot hand it back on their own.
function isClaimedTeamSeat(purchaseId: number) {
  const row = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
    )
    .get();

  return row !== undefined;
}

function getLessonIdsForCourse(courseId: number): number[] {
  const rows = db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all();

  return rows.map((row) => row.id);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

function getSecondsWatched(userId: number, lessonIds: number[]) {
  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}

// The Refund Window is counted in whole days, not hours — someone who buys at
// 23:00 should still get the whole of their fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function lastDayOfRefundWindow(purchasedAtIso: string): string {
  const deadline = new Date(purchasedAtIso);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}

function getCourseUsageReason(
  userId: number,
  courseId: number
): "completed_too_much" | "watched_too_much" | null {
  const lessonIds = getLessonIdsForCourse(courseId);

  if (lessonIds.length === 0) return null;

  const completedCount = getCompletedLessonCount(userId, lessonIds);
  if (completedCount / lessonIds.length >= COMPLETION_LIMIT) {
    return "completed_too_much";
  }

  if (getSecondsWatched(userId, lessonIds) >= WATCH_LIMIT_SECONDS) {
    return "watched_too_much";
  }

  return null;
}

/**
 * Whether the learner's latest Purchase of a course is eligible for a Refund
 * (see GLOSSARY.md). The course page and the refund route both ask this, so
 * the button and the request it sends can never disagree.
 */
export function getRefundEligibility(
  userId: number,
  courseId: number,
  now: Date = new Date()
): RefundEligibility {
  const purchase = getLatestPurchase(userId, courseId);

  if (!purchase) return { eligible: false, reason: "no_purchase" };

  if (hasRequestedRefundRequest(purchase.id)) {
    return { eligible: false, reason: "already_requested" };
  }

  if (isClaimedTeamSeat(purchase.id)) {
    return { eligible: false, reason: "claimed_team_seat" };
  }

  const lastDay = lastDayOfRefundWindow(purchase.createdAt);
  if (calendarDay(now) > lastDay) {
    return { eligible: false, reason: "window_closed" };
  }

  const usageReason = getCourseUsageReason(userId, courseId);
  if (usageReason) return { eligible: false, reason: usageReason };

  return {
    eligible: true,
    purchase,
    refundableAmount: purchase.amountPaid,
    lastDayOfRefundWindow: lastDay,
  };
}

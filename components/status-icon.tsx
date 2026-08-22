import { cn } from "@/lib/utils";
import { STATUS_COLORS, isTaskStatus } from "@/lib/model";

export function StatusIcon({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const key = isTaskStatus(status) ? status : "todo";
  const color = STATUS_COLORS[key];
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden
      className={cn("size-3.5 shrink-0", className)}
    >
      {key === "backlog" ? (
        <circle
          cx="7"
          cy="7"
          r="5.4"
          fill="none"
          stroke={color}
          strokeWidth="1.6"
          strokeDasharray="1.8 2"
        />
      ) : null}
      {key === "todo" ? (
        <circle
          cx="7"
          cy="7"
          r="5.4"
          fill="none"
          stroke={color}
          strokeWidth="1.6"
        />
      ) : null}
      {key === "in_progress" || key === "in_review" ? (
        <>
          <circle
            cx="7"
            cy="7"
            r="5.4"
            fill="none"
            stroke={color}
            strokeWidth="1.6"
          />
          {key === "in_progress" ? (
            <path d="M7 7 L7 2.4 A4.6 4.6 0 0 1 11.2 9.5 Z" fill={color} />
          ) : (
            <path d="M7 7 L7 2.4 A4.6 4.6 0 1 1 2.4 7 Z" fill={color} />
          )}
        </>
      ) : null}
      {key === "done" ? (
        <>
          <circle cx="7" cy="7" r="6" fill={color} />
          <path
            d="M4.4 7.2 l1.8 1.8 3.4-3.8"
            stroke="var(--canvas)"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
          />
        </>
      ) : null}
      {key === "canceled" ? (
        <>
          <circle cx="7" cy="7" r="6" fill={color} />
          <path
            d="M5 5 l4 4 M9 5 l-4 4"
            stroke="var(--canvas)"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </>
      ) : null}
    </svg>
  );
}

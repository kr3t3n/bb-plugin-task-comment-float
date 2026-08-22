import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  EMPTY_FILTERS,
  SORT_LABELS,
  TASK_SORTS,
  hasActiveFilters,
  toggled,
  type LabelFilterOption,
  type ListFilters,
  type TaskSort,
} from "@/lib/list-preference";
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from "@/lib/model";
import { StatusIcon } from "@/components/status-icon";

function FilterChip({
  icon,
  label,
  selectedNames,
  children,
}: {
  icon: "Circle" | "ArrowUpDown" | "ListTodo";
  label: string;
  selectedNames: string[];
  children: ReactNode;
}) {
  const active = selectedNames.length > 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs max-md:pointer-coarse:h-8",
            active
              ? "border-border bg-secondary text-foreground"
              : "border-dashed border-border text-muted-foreground hover:border-input hover:text-foreground",
          )}
        >
          <Icon name={icon} className="size-3" />
          {label}
          {active ? (
            <span className="max-w-48 truncate font-medium @max-md:max-w-24">
              {selectedNames.join(", ")}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PriorityIcon({
  priority,
  className,
}: {
  priority: string;
  className?: string;
}) {
  if (priority === "urgent") {
    return (
      <span
        aria-hidden
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center rounded-xs bg-warning text-2xs font-extrabold",
          className,
        )}
        style={{ color: "var(--canvas)" }}
      >
        !
      </span>
    );
  }
  const lit =
    priority === "high" ? 3 : priority === "medium" ? 2 : priority === "low" ? 1 : 0;
  const heights = [5, 8, 11];
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden
      className={cn(
        "size-3.5 shrink-0",
        priority === "none" ? "opacity-40" : undefined,
        className,
      )}
    >
      {heights.map((height, index) => (
        <rect
          key={height}
          x={1.5 + index * 4.5}
          y={12.5 - height}
          width="3"
          height={height}
          rx="1"
          fill={index < lit ? "var(--muted-foreground)" : "var(--muted)"}
        />
      ))}
    </svg>
  );
}

function SortChip({
  sort,
  onChange,
}: {
  sort: TaskSort;
  onChange: (next: TaskSort) => void;
}) {
  const active = sort !== "manual";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs max-md:pointer-coarse:h-8",
            active
              ? "border-border bg-secondary text-foreground"
              : "border-dashed border-border text-muted-foreground hover:border-input hover:text-foreground",
          )}
        >
          <Icon name="Sort" className="size-3" />
          Sort
          {active ? (
            <span className="font-medium">{SORT_LABELS[sort]}</span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-44"
        mobileTitle="Sort tasks"
      >
        {TASK_SORTS.map((option) => (
          <DropdownMenuCheckboxItem
            key={option}
            checked={sort === option}
            onCheckedChange={(checked) => {
              if (checked === true) onChange(option);
            }}
          >
            {SORT_LABELS[option]}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ListFilterBar({
  filters,
  onChange,
  sort,
  onSortChange,
  labelOptions,
  taskCount,
}: {
  filters: ListFilters;
  onChange: (next: ListFilters) => void;
  sort: TaskSort;
  onSortChange: (next: TaskSort) => void;
  labelOptions: LabelFilterOption[];
  taskCount: number;
}) {
  const keepOpen = (event: Event) => event.preventDefault();
  const showLabelChip = labelOptions.length > 0 || filters.labelNames.length > 0;
  const staleNames = filters.labelNames.filter(
    (name) => !labelOptions.some((option) => option.name === name),
  );

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border-hairline px-3.5 py-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        <FilterChip
          icon="Circle"
          label="Status"
          selectedNames={filters.statuses.map((status) => STATUS_LABELS[status])}
        >
          {TASK_STATUSES.map((status) => (
            <DropdownMenuCheckboxItem
              key={status}
              checked={filters.statuses.includes(status)}
              onSelect={keepOpen}
              onCheckedChange={(checked) =>
                onChange({
                  ...filters,
                  statuses: toggled(filters.statuses, status, checked === true),
                })
              }
            >
              <span className="flex items-center gap-2">
                <StatusIcon status={status} className="size-3" />
                {STATUS_LABELS[status]}
              </span>
            </DropdownMenuCheckboxItem>
          ))}
        </FilterChip>
        <FilterChip
          icon="ArrowUpDown"
          label="Priority"
          selectedNames={filters.priorities.map(
            (priority) => PRIORITY_LABELS[priority],
          )}
        >
          {TASK_PRIORITIES.map((priority) => (
            <DropdownMenuCheckboxItem
              key={priority}
              checked={filters.priorities.includes(priority)}
              onSelect={keepOpen}
              onCheckedChange={(checked) =>
                onChange({
                  ...filters,
                  priorities: toggled(
                    filters.priorities,
                    priority,
                    checked === true,
                  ),
                })
              }
            >
              <span className="flex items-center gap-2">
                <PriorityIcon priority={priority} className="size-3" />
                {PRIORITY_LABELS[priority]}
              </span>
            </DropdownMenuCheckboxItem>
          ))}
        </FilterChip>
        {showLabelChip ? (
          <FilterChip icon="ListTodo" label="Label" selectedNames={filters.labelNames}>
            {labelOptions.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.name}
                checked={filters.labelNames.includes(option.name)}
                onSelect={keepOpen}
                onCheckedChange={(checked) =>
                  onChange({
                    ...filters,
                    labelNames: toggled(
                      filters.labelNames,
                      option.name,
                      checked === true,
                    ),
                  })
                }
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ backgroundColor: option.color }}
                  />
                  {option.name}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
            {staleNames.map((name) => (
              <DropdownMenuCheckboxItem
                key={`stale:${name}`}
                checked
                onSelect={keepOpen}
                onCheckedChange={(checked) =>
                  onChange({
                    ...filters,
                    labelNames: toggled(filters.labelNames, name, checked === true),
                  })
                }
              >
                <span className="flex items-center gap-2 text-muted-foreground">
                  <span
                    aria-hidden
                    className="size-2 rounded-full bg-muted-foreground/40"
                  />
                  {name}
                  <span className="text-xs">(unavailable)</span>
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </FilterChip>
        ) : null}
        {hasActiveFilters(filters) ? (
          <button
            type="button"
            onClick={() => onChange(EMPTY_FILTERS)}
            className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-dashed border-border px-2.5 text-xs text-muted-foreground hover:border-input hover:text-foreground max-md:pointer-coarse:h-8"
          >
            <Icon name="X" className="size-3" />
            Clear
          </button>
        ) : null}
      </div>
      <SortChip sort={sort} onChange={onSortChange} />
      <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-subtle-foreground">
        {taskCount === 1 ? "1 task" : `${taskCount} tasks`}
      </span>
    </div>
  );
}

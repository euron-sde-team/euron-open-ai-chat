"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AdminStats } from "@open-chat/types";
import { api } from "@/lib/api";
import { RANGE_PRESETS, approval, formatCompact, formatCount, parsePreset, presetRange, type RangePreset } from "@/lib/admin";
import { qk } from "@/lib/query-keys";
import { ErrorState } from "@/components/common/states";
import { UnderlineTabs } from "@/components/common/underline-tabs";
import { AdminPage, AdminSection, Chart, DataTable, StatLine, useUrlState, type Column, type StatItem } from "../shell";

type ModelRow = AdminStats["byModel"][number];

export function AdminOverview() {
  const url = useUrlState();
  const preset = parsePreset(url.get("range"));
  const range = useMemo(() => presetRange(preset), [preset]);
  const q = useQuery({
    queryKey: qk.admin.list("stats", range),
    queryFn: () => api().admin.stats(range),
    placeholderData: (p) => p,
  });
  const s = q.data;

  return (
    <AdminPage
      title="Overview"
      description="Accounts and usage across the deployment. Days are counted in UTC."
      filters={
        <UnderlineTabs<`${RangePreset}`>
          tabs={RANGE_PRESETS.map((d) => ({ value: `${d}` as const, label: `Last ${d} days` }))}
          value={`${preset}`}
          onChange={(v) => url.set({ range: v === "30" ? null : v })}
          label="Date range"
        />
      }
      testId="admin-overview"
    >
      {q.isError && !s ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <div className={q.isPlaceholderData ? "opacity-60 transition-opacity" : "transition-opacity"}>
          <StatLine loading={!s} size="lg" items={totals(s)} testId="overview-totals" />
          <AdminSection title="By day" id="daily" className="mt-10">
            {s ? (
              <Chart
                data={s.daily}
                series={[
                  { key: "messages", label: "Messages", tone: "primary" },
                  { key: "activeUsers", label: "Active users", tone: "muted" },
                ]}
                title="Messages and active users per day"
                testId="overview-chart"
              />
            ) : (
              <div className="h-[240px] animate-shimmer rounded-md bg-muted" aria-hidden />
            )}
          </AdminSection>
          <ByModel stats={s} />
          <Feedback stats={s} />
        </div>
      )}
    </AdminPage>
  );
}

function totals(s: AdminStats | undefined): StatItem[] {
  const t = s?.totals;
  const v = (x: number | undefined) => (x === undefined ? "" : formatCount(x));
  return [
    { label: "Users", value: v(t?.users), testId: "stat-users" },
    { label: "Active users", value: v(t?.activeUsers), testId: "stat-active" },
    { label: "New users", value: v(t?.newUsers), testId: "stat-new" },
    { label: "Conversations", value: v(t?.conversations), testId: "stat-conversations" },
    { label: "Messages", value: v(t?.messages), testId: "stat-messages" },
    { label: "Images", value: v(t?.images), testId: "stat-images" },
    { label: "Weighted tokens", value: t ? formatCompact(t.weightedTokens) : "", testId: "stat-tokens" },
  ];
}

function ByModel({ stats }: { stats: AdminStats | undefined }) {
  const columns = useMemo<Column<ModelRow>[]>(
    () => [
      { key: "model", header: "Model", cell: (r) => <span className="font-medium text-foreground">{r.displayName}</span>, sortValue: (r) => r.displayName },
      { key: "messages", header: "Messages", align: "right", cell: (r) => formatCount(r.messages), sortValue: (r) => r.messages },
      { key: "in", header: "Input tokens", align: "right", cell: (r) => formatCompact(r.inputTokens), sortValue: (r) => r.inputTokens, hideBelow: "sm" },
      { key: "out", header: "Output tokens", align: "right", cell: (r) => formatCompact(r.outputTokens), sortValue: (r) => r.outputTokens, hideBelow: "sm" },
    ],
    [],
  );
  return (
    <AdminSection title="Usage by model" description="Raw tokens, before model weights." id="by-model" className="mt-10">
      <DataTable
        caption="Usage by model"
        rows={stats?.byModel ?? []}
        columns={columns}
        rowKey={(r) => r.modelId}
        loading={!stats}
        skeletonRows={4}
        empty={{ title: "No messages in this range." }}
        testId="overview-by-model"
      />
    </AdminSection>
  );
}

function Feedback({ stats }: { stats: AdminStats | undefined }) {
  const f = stats?.feedback;
  const pct = f ? approval(f.up, f.down) : null;
  return (
    <AdminSection title="Feedback on answers" id="feedback" className="mt-10">
      <StatLine
        loading={!f}
        testId="overview-feedback"
        items={[
          { label: "Thumbs up", value: f ? formatCount(f.up) : "" },
          { label: "Thumbs down", value: f ? formatCount(f.down) : "" },
          { label: "Rated helpful", value: f ? (pct === null ? "No ratings" : `${pct}%`) : "" },
        ]}
      />
    </AdminSection>
  );
}

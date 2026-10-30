import { Box, Text, render, renderToString, useInput, type Key } from "ink";
import stringWidth from "string-width";
import { plain, presentation } from "./presentation.js";
import type { DashboardState } from "./dashboard.js";

const colors: Record<string, string> = {
  accent: "cyan",
  muted: "gray",
  working: "cyan",
  blocked: "red",
  idle: "yellow",
  unknown: "red",
} as const;
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function fit(value: string, width: number): string {
  let result = "";
  for (const { segment } of segments.segment(plain(value))) {
    if (stringWidth(result + segment) > width) break;
    result += segment;
  }
  return result;
}

function Line({
  children,
  width,
  color,
  bold = false,
}: {
  children: string;
  width: number;
  color?: string;
  bold?: boolean;
}) {
  return (
    <Text wrap="truncate-end" color={color} bold={bold}>
      {fit(children, width)}
    </Text>
  );
}

// Rendering and navigation share the same viewport, including stacked and compact layouts.
function dashboardLayout(watchOnly = false, columns = 100, rows = 30) {
  const width = Math.max(1, columns - 1);
  const height = Math.max(1, rows - 1);
  const compact = width < 44 || height < 15;
  const wide = width >= 100 && !watchOnly;
  const bodyHeight = height - 6;
  const listHeight = watchOnly
    ? 0
    : wide
      ? bodyHeight
      : Math.min(8, Math.max(4, Math.floor(bodyHeight / 3)));
  const listWidth = wide ? Math.min(52, Math.floor(width * 0.43)) : width;
  const detailWidth = wide ? width - listWidth - 1 : width;
  const detailHeight = wide || watchOnly ? bodyHeight : bodyHeight - listHeight;
  const logRows = compact ? 0 : Math.max(1, detailHeight - 10);
  return {
    width,
    height,
    compact,
    wide,
    bodyHeight,
    listHeight,
    listWidth,
    detailWidth,
    detailHeight,
    logRows,
  };
}

export function activityOffset(
  state: DashboardState,
  columns = 100,
  rows = 30,
  offset = state.logOffset ?? 0,
): number {
  const { logRows } = dashboardLayout(state.watchOnly, columns, rows);
  return logRows ? Math.max(0, Math.min(offset, state.logs.length - logRows)) : 0;
}

export function Dashboard({
  state,
  columns = 100,
  rows = 30,
}: {
  state: DashboardState;
  columns?: number;
  rows?: number;
}) {
  const {
    width,
    height,
    compact,
    wide,
    bodyHeight,
    listHeight,
    listWidth,
    detailWidth,
    detailHeight,
    logRows,
  } = dashboardLayout(state.watchOnly, columns, rows);
  const selectedIndex = Math.max(
    0,
    state.entries.findIndex((entry) => entry.watch.id === state.selected),
  );
  const selected = state.entries[selectedIndex];
  const title = state.watchOnly ? "PR ACTIVITY" : "PR SITTER DASHBOARD";
  if (compact) {
    const lines = [
      title,
      `Controller ${state.running ? "running" : "STOPPED"}`,
      selected
        ? `#${selected.watch.number} ${selected.watch.owner}/${selected.watch.repo}`
        : "No PRs registered",
      selected ? presentation(selected, state.running).stage : "prsit watch <PR URL> --repo <path>",
      selected?.state?.message ?? "",
      "Enlarge pane for details and activity.",
      "j/k select  p pause  r resume  t retry",
      "o open  q quit",
      state.message,
    ];
    return (
      <Box flexDirection="column" width={width} height={height} overflow="hidden">
        {lines.slice(0, height).map((line, i) => (
          <Line key={i} width={width} color={i === 0 ? colors.accent : undefined}>
            {line}
          </Line>
        ))}
      </Box>
    );
  }
  const visibleCount = Math.max(1, Math.floor((listHeight - 3) / 2));
  const start = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(visibleCount / 2), state.entries.length - visibleCount),
  );
  const stage = selected ? presentation(selected, state.running) : undefined;
  const stageColor =
    stage?.stage === "merged"
      ? "green"
      : stage?.stage === "paused" || stage?.stage === "unwatched"
        ? "gray"
        : colors[stage?.semantic ?? "idle"];
  const stages = state.entries.map((entry) => presentation(entry, state.running));
  const counts = `${state.entries.length} watches   ${stages.filter((s) => s.semantic === "working").length} working   ${stages.filter((s) => s.stage === "blocked").length} blocked   ${stages.filter((s) => s.stage === "merged").length} merged   ${stages.filter((s) => s.stage === "paused").length} paused`;
  const innerWidth = Math.max(1, detailWidth - 4);
  const offset = activityOffset(state, columns, rows);
  const logEnd = state.logs.length - offset;
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Box justifyContent="space-between" height={1} flexShrink={0}>
        <Text bold color={colors.accent}>
          {title}
        </Text>
        <Text color={state.running ? "green" : "red"} bold>
          {state.running ? "● Controller running" : "● Controller STOPPED"}
        </Text>
      </Box>
      <Line width={width} color={colors.muted}>
        {counts}
      </Line>
      <Box height={1} flexShrink={0}>
        <Line width={width} color={state.running ? colors.muted : "yellow"}>
          {state.running
            ? "Local PR supervision · select a watch to inspect its progress"
            : "Work is stopped. Controls queue until you start prsit run."}
        </Line>
      </Box>
      <Box
        flexDirection={wide ? "row" : "column"}
        height={bodyHeight}
        flexShrink={0}
        gap={wide ? 1 : 0}
      >
        {!state.watchOnly && (
          <Box
            flexDirection="column"
            width={listWidth}
            height={listHeight}
            borderStyle="round"
            borderColor={colors.muted}
            paddingX={1}
            overflow="hidden"
            flexShrink={0}
          >
            <Line
              width={listWidth - 4}
              color={colors.muted}
            >{`WATCHES  ${state.entries.length ? selectedIndex + 1 : 0}/${state.entries.length}  ↑↓ select`}</Line>
            {!state.entries.length && <Text color="gray">No PRs registered</Text>}
            {state.entries.slice(start, start + visibleCount).map((entry) => {
              const active = entry.watch.id === selected?.watch.id;
              const status = presentation(entry, state.running);
              const label = fit(
                `${active ? ">" : " "} #${entry.watch.number} ${entry.watch.owner}/${entry.watch.repo}`,
                listWidth - 4,
              );
              return (
                <Box key={entry.watch.id} flexDirection="column" flexShrink={0}>
                  <Box width={listWidth - 4}>
                    <Text
                      backgroundColor={active ? "cyan" : undefined}
                      color={active ? "black" : undefined}
                      bold={active}
                    >
                      {label + " ".repeat(Math.max(0, listWidth - 4 - stringWidth(label)))}
                    </Text>
                  </Box>
                  <Line
                    width={listWidth - 4}
                    color={status.stage === "merged" ? "green" : colors[status.semantic]}
                  >{`  ${status.stage}`}</Line>
                </Box>
              );
            })}
          </Box>
        )}
        <Box
          flexDirection="column"
          width={detailWidth}
          height={detailHeight}
          borderStyle="round"
          borderColor={stageColor}
          paddingX={1}
          overflow="hidden"
          flexShrink={0}
        >
          {selected ? (
            <>
              <Line
                width={innerWidth}
                bold
              >{`#${selected.watch.number} ${selected.watch.owner}/${selected.watch.repo}`}</Line>
              <Line width={innerWidth} color={stageColor} bold>
                {stage?.stage.toUpperCase() ?? "WATCHING"}
              </Line>
              <Box height={2} flexShrink={0} overflow="hidden">
                <Text>
                  {plain(selected.state?.message ?? "Registered; waiting for the controller.")}
                </Text>
              </Box>
              <Line width={innerWidth} color={colors.muted}>
                {selected.watch.url}
              </Line>
              <Line width={innerWidth} color={colors.muted}>
                {selected.state?.job?.worktree ? `Worktree: ${selected.state.job.worktree}` : ""}
              </Line>
              <Line
                width={innerWidth}
                color={colors.accent}
              >{`ACTIVITY  ${offset ? `${offset} lines back` : "live"}  · PgUp/PgDn · End live`}</Line>
              <Box flexDirection="column" height={logRows} overflow="hidden" flexShrink={0}>
                {state.logs.length ? (
                  state.logs.slice(Math.max(0, logEnd - logRows), logEnd).map((line, i) => (
                    <Line key={i} width={innerWidth}>
                      {line}
                    </Line>
                  ))
                ) : (
                  <Text dimColor>No activity yet.</Text>
                )}
              </Box>
            </>
          ) : (
            <>
              <Text bold color="cyan">
                Your PR watch list is empty
              </Text>
              <Text>Register a pull request from its checkout:</Text>
              <Text color="yellow">prsit watch 123</Text>
              <Text dimColor>Or use: prsit watch &lt;PR URL&gt; --repo &lt;path&gt;</Text>
            </>
          )}
        </Box>
      </Box>
      <Line width={width} color={state.message ? "yellow" : colors.muted}>
        {state.message || "Closing this view leaves the controller and repairs running."}
      </Line>
      <Line width={width}>
        {width < 75
          ? "p pause  r resume  t retry  o open  q quit"
          : "↑↓ j/k select   p pause   r resume   t retry   o open activity   q quit"}
      </Line>
      <Line width={width} color={colors.muted}>
        {"j/k select · PgUp/PgDn scroll · End live"}
      </Line>
    </Box>
  );
}

export function renderDashboard(state: DashboardState, columns = 100, rows = 30): string {
  return renderToString(<Dashboard state={state} columns={columns} rows={rows} />, {
    columns,
  }).replace(/\n/g, "\r\n");
}

function InteractiveDashboard({
  onKey,
  ...props
}: Parameters<typeof Dashboard>[0] & { onKey: (input: string, key: Key) => void }) {
  useInput(onKey);
  return <Dashboard {...props} />;
}

export function mountDashboard(state: DashboardState, onKey: (input: string, key: Key) => void) {
  const element = (snapshot: DashboardState) => (
    <InteractiveDashboard
      state={snapshot}
      columns={process.stdout.columns ?? 100}
      rows={process.stdout.rows ?? 30}
      onKey={onKey}
    />
  );
  const view = render(element({ ...state }), {
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: true,
    alternateScreen: true,
  });
  return {
    update: () => view.rerender(element({ ...state })),
    close: async () => {
      view.unmount();
      await view.waitUntilExit();
      view.cleanup();
    },
  };
}

export const dashboardTerminal = { mount: mountDashboard };

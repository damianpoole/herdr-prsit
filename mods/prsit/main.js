import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme, props, run, layout, focused, nextCommand, notify } from "herdr";
import { call, watchArgs, findBlock } from "./client.js";
import installedConfig from "./config.js";

export default class PrSitter extends View {
  init(_props, cx) {
    this.config = { ...installedConfig, ...props() };
    this.selected = this.config.watch ?? null;
    this.snapshot = null;
    this.error = "";
    this.actionError = "";
    this.busy = false;
    this.loading = false;
    this.showHistory = false;
    this.form = false;
    this.handle = cx.focus_handle();
    this.inputs = Object.fromEntries(
      ["pr", "repo", "model", "test", "interval"].map((key) => [
        key,
        InputState.new({
          placeholder: {
            pr: "PR number or HTTPS URL",
            repo: "Local repository path",
            model: "provider/model-id (or Pi default)",
            test: "Validation command (optional)",
            interval: "15m",
          }[key],
        }),
      ]),
    );
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.handle.focus();
        if (command === "refresh") this.refresh(cx);
        if (command === "watch") {
          this.form = true;
          cx.notify();
        }
      }
    });
    cx.timer.every(5000, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    const selected = this.selected;
    cx.spawn(async (cx) => {
      try {
        const next = await call(
          exec,
          this.config,
          ["snapshot", ...(selected ? [selected] : [])],
          true,
        );
        if (selected !== this.selected) return;
        const changed = JSON.stringify(next) !== JSON.stringify(this.snapshot);
        this.snapshot = next;
        const hadError = !!this.error;
        this.error = "";
        if (changed || hadError) cx.notify();
      } catch (error) {
        const message = String(error.message ?? error);
        if (message !== this.error) {
          this.error = message;
          cx.notify();
        }
      } finally {
        this.loading = false;
      }
    });
  }

  action(args, cx) {
    if (this.busy) return;
    this.busy = true;
    this.actionError = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await call(exec, this.config, args);
        if (args[0] === "watch") this.form = false;
      } catch (error) {
        this.actionError = String(error.message ?? error);
      } finally {
        this.busy = false;
        cx.notify();
      }
      // Polling health must never erase a failed registration/control.
      this.refresh(cx);
    });
  }

  openPanel() {
    const tree = layout();
    if (findBlock(tree, "prsit-panel") && findBlock(tree, "panel-body")) {
      run("layout.select", { stack: "panel-body", child: "prsit-panel" });
      run("layout.show", { id: "panel" });
      return;
    }
    // PaneInfo does not expose props/state-directory identity. Do not reuse an
    // arbitrary PR Sitter pane that may be connected to a different controller.
    const focus = focused();
    if (focus?.space)
      run("tab.new", {
        space: focus.space,
        name: "PR Sitter",
        mod: "prsit",
        props: { ...this.config, role: "panel" },
      });
    else
      notify({
        title: "PR Sitter",
        body: "Open a space first, then open PR Sitter.",
        level: "info",
      });
  }

  button(id, label, action, t, active = false) {
    return h_flex()
      .id(id)
      .h(26)
      .px(9)
      .gap(5)
      .items_center()
      .rounded(6)
      .border_1()
      .border_color(active ? t.accent : t.border)
      .bg(active ? t.selected : t.background)
      .text_color(t.foreground)
      .text_size(12)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_event, cx) => action(cx))
      .child(label);
  }

  submit(cx) {
    try {
      this.action(
        watchArgs(
          Object.fromEntries(
            Object.entries(this.inputs).map(([key, input]) => [key, input.value()]),
          ),
        ),
        cx,
      );
    } catch (error) {
      this.actionError = error.message;
      cx.notify();
    }
  }

  watchForm(t) {
    const label = (text) => div().text_size(11).text_color(t.muted).child(text);
    return v_flex()
      .gap(8)
      .p(12)
      .border_b_1()
      .border_color(t.border)
      .child(label("Watch a PR · local machine"))
      .children(
        Object.entries(this.inputs).map(([key, input]) =>
          Input.new(input)
            .id(`prsit-input-${key}`)
            .h(30)
            .px(8)
            .rounded(6)
            .border_1()
            .border_color(t.input)
            .bg(t.background)
            .text_color(t.foreground)
            .text_size(12),
        ),
      )
      .child(
        label(
          "Registration authorizes autonomous commits, pushes, review replies, thread resolution and eligible merging.",
        ),
      )
      .child(
        h_flex()
          .gap(6)
          .child(
            this.button(
              "watch-submit",
              this.busy ? "Working…" : "Watch PR",
              (cx) => this.submit(cx),
              t,
            ),
          )
          .child(
            this.button(
              "watch-cancel",
              "Cancel",
              (cx) => {
                this.form = false;
                cx.notify();
              },
              t,
            ),
          ),
      );
  }

  details(entry, t) {
    return v_flex()
      .gap(8)
      .p(12)
      .border_t_1()
      .border_color(t.border)
      .child(div().font_semibold().child(`#${entry.number} · ${entry.repository}`))
      .child(
        div()
          .text_color(t[entry.semantic] ?? t.muted)
          .child(entry.stage),
      )
      .child(div().text_color(t.muted).child(entry.message))
      .child(div().text_size(11).text_color(t.dim).child(`${entry.agent} · ${entry.model}`))
      .when(!!entry.worktree, (el) =>
        el.child(div().text_size(11).text_color(t.muted).child(entry.worktree)),
      )
      .child(
        h_flex()
          .gap(5)
          .flex_wrap()
          .children(
            [
              ["pause", "Pause"],
              ["resume", "Resume"],
              ["retry", "Retry"],
              ["unwatch", "Unwatch"],
            ].map(([action, label]) =>
              this.button(
                `action-${action}`,
                label,
                (cx) => this.action([action, entry.id], cx),
                t,
              ),
            ),
          ),
      )
      .child(div().pt(6).text_size(11).text_color(t.dim).child("RECENT ACTIVITY"))
      .children(
        (this.snapshot?.activity ?? [])
          .slice(-1000)
          .map((line) => div().text_size(11).text_color(t.muted).child(line)),
      )
      .when(!this.snapshot?.activity.length, (el) =>
        el.child(div().text_color(t.dim).child("No activity yet")),
      );
  }

  render() {
    const t = theme();
    const entries = this.snapshot?.watches ?? [];
    const active = entries.filter(
      (entry) => entry.mode !== "removed" && !["merged", "closed"].includes(entry.stage),
    );
    const running = this.snapshot?.controllerRunning;
    const health = this.error
      ? "Unavailable"
      : this.snapshot
        ? running
          ? "Running"
          : "Stopped"
        : "Connecting…";
    if (this.config.role === "strip") {
      return h_flex()
        .id("prsit-strip")
        .h_full()
        .px(8)
        .gap(6)
        .items_center()
        .bg(t.chrome)
        .child(this.button("prsit-open", `PR Sitter · ${active.length}`, () => this.openPanel(), t))
        .child(
          div()
            .text_size(11)
            .text_color(running ? t.working : t.muted)
            .child(health),
        );
    }
    const visible = this.showHistory
      ? entries
      : entries.filter((entry) => entry.mode !== "removed");
    const entry = entries.find((item) => item.id === this.selected);
    return v_flex()
      .id("prsit-panel-root")
      .track_focus(this.handle)
      .size_full()
      .min_h(0)
      .bg(t.surface)
      .text_color(t.foreground)
      .text_size(12)
      .child(
        h_flex()
          .h(40)
          .px(12)
          .gap(8)
          .items_center()
          .border_b_1()
          .border_color(t.border)
          .child(div().flex_1().font_semibold().child("PR Sitter"))
          .child(
            this.button(
              "prsit-add",
              "+ Watch",
              (cx) => {
                this.form = !this.form;
                cx.notify();
              },
              t,
              this.form,
            ),
          ),
      )
      .child(
        h_flex()
          .px(12)
          .py(8)
          .gap(6)
          .items_center()
          .child(
            div()
              .flex_1()
              .text_color(running ? t.working : t.muted)
              .child(`Controller · ${health}`),
          )
          .child(
            this.button(
              "prsit-start",
              this.busy ? "Working…" : running ? "Stop" : "Start",
              (cx) => this.action([running ? "stop" : "start"], cx),
              t,
            ),
          )
          .child(this.button("prsit-refresh", "Refresh", (cx) => this.refresh(cx), t)),
      )
      .when(!!(this.error || this.actionError), (el) =>
        el.child(
          div()
            .px(12)
            .py(8)
            .text_color(t.blocked)
            .child(this.actionError || this.error),
        ),
      )
      .when(this.form, (el) => el.child(this.watchForm(t)))
      .child(
        v_flex()
          .id("prsit-scroll")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .children(
            visible.map((item) =>
              v_flex()
                .id(`prsit-${item.id}`)
                .px(12)
                .py(9)
                .gap(4)
                .bg(item.id === this.selected ? t.selected : t.surface)
                .hover((s) => s.bg(t.hover))
                .cursor_pointer()
                .on_click((_event, cx) => {
                  this.selected = item.id;
                  this.snapshot = { ...this.snapshot, activity: [] };
                  this.refresh(cx);
                  cx.notify();
                })
                .child(div().child(`#${item.number} · ${item.repository}`))
                .child(
                  div()
                    .text_size(11)
                    .text_color(t[item.semantic] ?? t.muted)
                    .child(item.stage),
                ),
            ),
          )
          .when(!visible.length, (el) =>
            el.child(
              div().p(12).text_color(t.muted).child("No watched PRs. Use + Watch to register one."),
            ),
          )
          .when(!!entry, (el) => el.child(this.details(entry, t))),
      )
      .child(
        h_flex()
          .px(12)
          .py(8)
          .child(
            this.button(
              "prsit-history",
              this.showHistory ? "Hide unwatched" : "Show unwatched",
              (cx) => {
                this.showHistory = !this.showHistory;
                cx.notify();
              },
              t,
            ),
          ),
      );
  }
}

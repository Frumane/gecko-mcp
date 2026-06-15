/**
 * MCP tool annotations — behaviour hints clients use to gate execution (auto-run
 * read-only tools, confirm destructive ones). Kept separate so it's unit-tested
 * without starting the server. openWorldHint is true throughout: every tool
 * ultimately reaches the open web through the browser.
 *
 * NOTE: annotations are advisory hints, not a security boundary — a client must
 * not trust them for safety from an untrusted server. For this trusted local
 * server they accurately describe each tool.
 */

const ro = (title: string) => ({ title, readOnlyHint: true, openWorldHint: true });
const mut = (title: string) => ({ title, readOnlyHint: false, destructiveHint: false, openWorldHint: true });
const destroy = (title: string) => ({ title, readOnlyHint: false, destructiveHint: true, openWorldHint: true });

export const ANNOTATIONS: Record<string, Record<string, unknown>> = {
  list_tabs: ro("List tabs"),
  open_tab: mut("Open tab"),
  get_active_tab: ro("Get active tab"),
  navigate_tab: { ...destroy("Navigate tab"), idempotentHint: true },
  close_tab: destroy("Close tab"),
  read_page: ro("Read page"),
  screenshot: ro("Screenshot"),
  find: ro("Find elements"),
  click: mut("Click"),
  snapshot: ro("Page snapshot"),
  type_text: mut("Type text"),
  fill_form: mut("Fill form"),
  press_key: mut("Press key"),
  wait_for_element: ro("Wait for element"),
  get_value: ro("Get field value"),
  real_type: mut("Type (real keyboard)"),
  real_key: mut("Press key (real keyboard)"),
  real_clear: mut("Clear field (real keyboard)"),
  hover: mut("Hover"),
  double_click: mut("Double-click"),
  right_click: mut("Right-click"),
  select_option: mut("Select option"),
  set_checked: mut("Set checkbox / radio"),
  submit_form: destroy("Submit form"),
  upload_file: destroy("Upload file"),
  get_attribute: ro("Get attribute"),
  get_article: ro("Get article"),
  get_cookies: ro("Get cookies"),
  wait_for_network_idle: ro("Wait for network idle"),
  list_workspaces: ro("List workspaces"),
  switch_workspace: mut("Switch workspace"),
  window_bounds: ro("Floorp window bounds"),
  move_cursor: mut("Move cursor"),
  real_click: mut("Click (real mouse)"),
  launch_floorp: { ...mut("Launch Floorp"), idempotentHint: true },
  launch: { ...mut("Launch browser"), idempotentHint: true },
  evaluate: destroy("Evaluate JavaScript"),
  enable_os_input: { title: "Enable OS input", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  disable_os_input: { title: "Disable OS input", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  enable_evaluate: { title: "Enable evaluate", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  disable_evaluate: { title: "Disable evaluate", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

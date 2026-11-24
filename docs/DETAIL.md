Keep the native sidebar workflow while grouping sessions by status, workspace, or one list.

Use the controls below for the sidebar display, off-peak snooze, message history search (off by default), automatic settling and workspace policies, or return here anytime from **View options → Sidebar settings…** in the sidebar. **Off-peak snooze** is on by default and saved per browser.

During DeepSeek peak pricing hours, **Snooze → Until off-peak** hides a non-working session until the half-price hours begin; it never sends a prompt, creates an Automation task, or pauses the agent. For a known-idle session with the Host backend and Harness scheduler, **Resume at off-peak…** additionally creates a one-shot **Off-peak resume** task, visible under **Automation tasks**, with your editable message (default “Continue.”). **Return now and cancel resume** or **Settle** cancels it before delivery; the Host must be running for the Harness to deliver it.

The setting below shows peak hours in your time zone and links to [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing). Chinese public holidays come from [holiday-cn](https://github.com/NateScarlet/holiday-cn) (MIT) and cover 2026–2027; refresh them with `pnpm run holidays:update <year>`. Other years fall back to the weekday rule.

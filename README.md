# PR Call Map

Follow direct calls while reviewing a GitHub pull request. Click or select a function name in the diff to show its callers and callees in the panel. In the full diff, moving between new-side lines with the arrow keys selects the enclosing function. Choose a function in the graph to show its definition in GitHub, or its call site if the diff omits the definition. Click a filename and line number to open the definition, changed line or call site in the diff.

The right pane groups the selected line, definitions, added calls and matching tests by file. Each filename appears above its group. Paths distinguish files with the same name. All locations and assertion lines in the patch are expanded. Tab to a line and press Enter to open it. The first Tab stop in the panel, **Skip to details**, takes you straight to the right pane.

Select a line in an enum declaration to see its members, explicit values and matching uses in the new-side PR diff. Each use shows the code and links to its line. The enum view covers complete declarations visible in one diff hunk, including C typedef enums and C++ scoped enums.

Selecting an added, single-line file-scope static variable in C shows matching references in the same file’s new-side diff. The map uses the visible identifiers and scopes to find references.

The tree shows a recognized function rename as `old → new` with any edits to its body. In the full GitHub diff, lines that match after accounting for the rename use a neutral background.

The map lists modules in the order their first file appears in GitHub’s file list, using patch order when that list is incomplete. Headers stay with their implementation directory. Module and file cards use the available width. Expanding a card shows its contents inside its border. Open a file to see its functions, renames and changed ranges as indented rows. Each module and file shows the number of changed test cases and the number of lines added or removed in test files. A case or line shared by several files counts once in the module. The map links tests using calls visible in the diff and matching filenames. In a module containing only test changes, select the module to open the diff. A pure rename counts once per location. Each bubble has a split bar with removed lines on the left and added lines on the right. Both sides use the same scale. Stripes show test lines. Each function row shows its starting line and change count. Press Enter on the row to open that interval in GitHub. Short, similar one-line replacements share a preview with the removed and inserted text marked inline. Click the preview for the new line or the minus-prefixed line number for the old line. The details pane shows the selected line of a range. Other changes appear under their filename. In the tree, use ↑ and ↓ to move, → to expand or enter a branch, and ← to collapse it or move to its parent. Moving through the tree highlights the corresponding line in GitHub and keeps keyboard focus in the tree when the line is visible. Press Enter on a range to open its line link.

Clicks, arrow keys and the active diff line open one tree path at a time. The left pane contains the change tree and callers. The GitHub diff stays in the middle. The right pane shows the selected code change, matching assertions and added calls. Both panes are 390 px wide, capped at 34.5% of the window each on smaller screens. The bottom of each change bar shows the share of changed lines in files marked Viewed. When some files have unknown status, the percentage shows the confirmed minimum. The toolbar button and the × in the map close it.

Argument changes compares complete, single-line calls to the same qualified function when a single argument was added or replaced. Choose a value to inspect its locations. A minority value is marked when one value has a strict majority. Production and test calls are compared separately.

Moving to an edited line with the arrow keys shows matching assertions for its member names. Press Enter on an assertion to open its test line. Back or Alt+Left restores the previous review location and its open groups.

In Chrome 123 or later, open `chrome://extensions`, enable Developer mode, choose **Load unpacked** and select the `extension` directory. Open **Files changed** in a PR on github.com to activate PR Call Map automatically. Closing the map keeps it closed in that tab until you reopen it via the Chrome extensions menu.

The panel fetches the full PR diff from GitHub using your browser session and analyzes it locally. It uses the added lines and their surrounding context, including files outside the current viewport. A line link opens the full PR diff even when you started from a filtered commit view. Click ↻ after new commits arrive.

The analyzer recognizes common function and method declarations in Rust, C/C++, Kotlin and JavaScript/TypeScript. It groups calls by language family and name. Overloads and methods with the same name can appear together. Indirect calls and declarations outside the diff can be missing.

Run the analyzer tests with `node --test test/*.test.mjs` from this directory using Node.js 22 or later.

# Workspace Customization Rules

## Issue Completion and Closing Process
Whenever the implementation of a specific issue is finished:
1. Ask the user if they consider the issue complete.
2. If the user confirms (says "yes" or similar), close the corresponding issue on GitHub.
3. Write a highly detailed closing comment for the closed issue that lists all specific modifications made to the website/codebase. The description should not be brief—it must document:
   - What components were added, modified, or deleted.
   - Any visual changes, layout modifications, color token updates, or copywriting updates (e.g., logos updated, text sections rewritten, new navigation tabs added).
   - Verification and manual testing summaries.
4. After closing the issue, push the code changes to the remote `dev` branch and then merge the `dev` branch into the `main` branch.

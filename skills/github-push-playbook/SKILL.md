---
name: github-push-playbook
description: Use when pushing local code to GitHub from Windows/PowerShell, especially for first-time repo setup, commit/push workflow, and handling intermittent network failures (443 reset/timeout), lock files, and branch tracking.
---

# GitHub Push Playbook

## When to use

Use this skill when the user asks to upload code to GitHub, push commits, or resolve push failures on Windows PowerShell.

## Standard workflow

1. Verify repository state.
```powershell
git status
git branch --show-current
git remote -v
```

2. If not a git repo, initialize and set main.
```powershell
git init -b main
```

3. Stage and commit.
```powershell
git add -A
git commit -m "feat: <summary>"
```

4. Configure remote if needed.
```powershell
git remote remove origin 2>$null
git remote add origin https://github.com/<owner>/<repo>.git
```

5. Push.
```powershell
git push -u origin main
```

## Failure handling (Windows-focused)

### A) `index.lock` exists
```powershell
if (Test-Path .git\index.lock) { Remove-Item .git\index.lock -Force }
```
Then retry commit/push.

### B) 443 network reset / timeout (`Could not connect`, `Connection was reset`)
1. Retry push in loop (best practical fix for unstable links).
```powershell
$ok=$false; 1..6 | % { git push -u origin main; if ($LASTEXITCODE -eq 0) { $ok=$true; break }; Start-Sleep -Seconds 3 }; if (-not $ok) { exit 1 }
```
2. Force HTTP/1.1 and retry.
```powershell
git config --local http.version HTTP/1.1
git push -u origin main
```
3. Confirm result.
```powershell
git status
```
If it shows `up to date with 'origin/main'`, push succeeded.

### C) Branch ahead but not pushed
If `git status` shows `ahead of 'origin/main' by N commits`, run:
```powershell
git push origin main
```

## Practical guardrails

- Avoid parallel git mutations (`init/add/commit`) in one concurrent batch.
- Commit in small logical units when possible.
- Keep `.gitignore` updated before first push to avoid shipping local logs/temp files.
- For Windows PowerShell, avoid `&&`; run commands in separate lines.

## Recommended `.gitignore` starters for local web projects

```gitignore
server*.log
.tmp_*
```

## Done criteria

- `git status` => clean working tree
- branch tracks remote (`-u` set)
- remote repo shows latest commits


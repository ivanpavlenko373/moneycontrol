@echo off
rem ======================================================================
rem  MoneyControl - publish to GitHub and enable GitHub Pages
rem  Repo:  https://github.com/ivanpavlenko373/moneycontrol
rem  Site:  https://ivanpavlenko373.github.io/moneycontrol/
rem  Run by double-click. Safe to run again after every change.
rem ======================================================================
setlocal EnableExtensions
cd /d "%~dp0"

set "GH_USER=ivanpavlenko373"
rem username in URL makes Git Credential Manager use exactly this account
set "REPO_URL=https://%GH_USER%@github.com/ivanpavlenko373/moneycontrol.git"
set "OWNER_REPO=ivanpavlenko373/moneycontrol"
set "PAGES_URL=https://ivanpavlenko373.github.io/moneycontrol/"
set "ORIGIN_URL=https://ivanpavlenko373.github.io"

echo.
echo === MoneyControl deploy ===
echo.

rem ---------- 1. git ----------
where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Git is not installed. Download: https://git-scm.com/download/win
  goto :fail
)

findstr /c:"CLIENT_ID: ''" "js\config.js" >nul 2>nul
if not errorlevel 1 (
  echo [WARN] CLIENT_ID in js\config.js is empty. The site will deploy,
  echo        but Google sign-in will not work until you set it. See README.md.
  echo.
)

if exist ".git" goto :repo_ready
echo [1/5] Initializing git repository...
git init >nul || goto :fail
git symbolic-ref HEAD refs/heads/main
:repo_ready

rem ---------- 2. identity ----------
git config user.name >nul 2>nul
if not errorlevel 1 goto :have_name
set /p "GIT_NAME=Enter your name for git commits: "
git config user.name "%GIT_NAME%"
:have_name
git config user.email >nul 2>nul
if not errorlevel 1 goto :have_email
set /p "GIT_EMAIL=Enter your GitHub e-mail: "
git config user.email "%GIT_EMAIL%"
:have_email

rem ---------- 3. remote ----------
echo [2/5] Setting remote origin...
git remote get-url origin >nul 2>nul
if errorlevel 1 (
  git remote add origin "%REPO_URL%"
) else (
  git remote set-url origin "%REPO_URL%"
)

rem ---------- 4. commit ----------
echo [3/5] Committing changes...
git add -A
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "Deploy MoneyControl %DATE% %TIME:~0,5%" || goto :fail
) else (
  echo        No changes to commit.
)
rem make sure the branch is called main
git branch -M main >nul 2>nul

rem ---------- 5. push ----------
set "RETRY=0"
:push
echo [4/5] Pushing to GitHub - a browser window may open for sign-in...
git push -u origin main
if not errorlevel 1 goto :pushed
echo.
git ls-remote origin >nul 2>nul
if errorlevel 1 goto :access_problem
echo [INFO] Push rejected - remote has commits that are not here. Merging them...
git pull origin main --allow-unrelated-histories --no-edit || goto :fail
git push -u origin main || goto :fail
:pushed

rem ---------- 6. GitHub Pages ----------
echo [5/5] Configuring GitHub Pages...
where gh >nul 2>nul
if errorlevel 1 goto :pages_manual

gh auth status >nul 2>nul
if errorlevel 1 (
  echo        GitHub CLI is not signed in. Starting sign-in...
  gh auth login --web --git-protocol https || goto :pages_manual
)

gh api "repos/%OWNER_REPO%/pages" >nul 2>nul
if errorlevel 1 (
  gh api -X POST "repos/%OWNER_REPO%/pages" -f "source[branch]=main" -f "source[path]=/" >nul || goto :pages_manual
  echo        GitHub Pages enabled.
) else (
  gh api -X PUT "repos/%OWNER_REPO%/pages" -f "source[branch]=main" -f "source[path]=/" >nul 2>nul
  echo        GitHub Pages already enabled - source is main / root.
)
goto :done

:pages_manual
echo.
echo [ACTION] Enable GitHub Pages manually - the settings page will open now:
echo          Source: Deploy from a branch,  Branch: main,  Folder: / root,  Save.
echo          Tip: install GitHub CLI to automate this step:  winget install --id GitHub.cli
start "" "https://github.com/%OWNER_REPO%/settings/pages"

:done
echo.
echo ==================================================================
echo  Done. The site will be live in 1-2 minutes at:
echo    %PAGES_URL%
echo.
echo  In Google Cloud Console - OAuth client - Authorized JavaScript
echo  origins, make sure this origin is added:
echo    %ORIGIN_URL%
echo ==================================================================
echo.
pause
exit /b 0

:access_problem
echo.
echo [CHECK] Trying to read the repo anonymously, without saved credentials...
set "GIT_TERMINAL_PROMPT=0"
git -c credential.helper= ls-remote "https://github.com/%OWNER_REPO%.git" >nul 2>nul
set "ANON=%ERRORLEVEL%"
set "GIT_TERMINAL_PROMPT="
if not "%ANON%"=="0" goto :repo_unreachable

echo [RESULT] The repo is public and reachable, so the SAVED GitHub credentials
echo          on this PC are the problem - they belong to another account or are
echo          a token without access to this repository.
if "%RETRY%"=="1" goto :creds_manual
echo.
choice /c YN /m "Remove saved GitHub credentials and sign in again as %GH_USER%"
if errorlevel 2 goto :creds_manual
git credential-manager github logout %GH_USER% >nul 2>nul
(echo protocol=https& echo host=github.com& echo username=%GH_USER%& echo.) | git credential reject
(echo protocol=https& echo host=github.com& echo.) | git credential reject
cmdkey /delete:git:https://github.com >nul 2>nul
cmdkey /delete:git:https://%GH_USER%@github.com >nul 2>nul
set "RETRY=1"
echo        Saved credentials removed. Retrying - sign in as %GH_USER% in the browser.
echo.
goto :push

:creds_manual
echo.
echo  Do it manually:
echo   1. Control Panel - Credential Manager - Windows Credentials:
echo      delete every entry that starts with "git:https://github.com"
echo   2. Run deploy.bat again and sign in as %GH_USER% in the browser.
goto :fail

:repo_unreachable
echo [RESULT] Even anonymous access fails. Check that:
echo   - the repository name is exactly %OWNER_REPO%
echo   - it is Public, or you sign in with an account that has access
echo   - github.com is not blocked by a proxy / corporate network on this PC
echo     try:  https://github.com/%OWNER_REPO%  in the browser of THIS PC
goto :fail

:fail
echo.
echo [ERROR] Deploy failed. See the messages above.
pause
exit /b 1

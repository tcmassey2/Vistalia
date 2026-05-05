#!/bin/zsh
# Load full login shell environment so npm/node are on PATH
source ~/.zprofile 2>/dev/null
source ~/.zshrc 2>/dev/null
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
export PATH="$HOME/.volta/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")"
npm install --prefer-offline 2>/dev/null || npm install
npm run dev

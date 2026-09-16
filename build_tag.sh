#!/usr/bin/env bash
#
# 从 manifest.json 读取版本号，打 tag 并推送到 origin。
#
# tag 名必须与 manifest.json 的 version 完全一致（裸语义化版本，不带 v 前缀），
# 否则 .github/workflows/release.yml 的校验步骤会因字符串不等而直接失败。
#
# 兼容 macOS 自带的 bash 3.2，脚本内不使用 bash 4+ 语法。
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
	C_RED=$'\033[31m'; C_YEL=$'\033[33m'; C_GRN=$'\033[32m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
	C_RED=''; C_YEL=''; C_GRN=''; C_DIM=''; C_RST=''
fi

err() {
	printf '%s✗%s %s\n' "$C_RED" "$C_RST" "$1" >&2
	shift || true
	for line in "$@"; do
		printf '  %s\n' "$line" >&2
	done
}

die() {
	err "$@"
	exit 1
}

warn() {
	printf '%s!%s %s\n' "$C_YEL" "$C_RST" "$1" >&2
}

ok() {
	printf '%s✓%s %s\n' "$C_GRN" "$C_RST" "$1"
}

usage() {
	cat <<'USAGE'
从 manifest.json 读取版本号，打 tag 并推送到 origin。

用法:
  ./build_tag.sh            前置检查通过后，交互确认，打 tag 并推送
  ./build_tag.sh --yes      跳过交互确认
  ./build_tag.sh --dry-run  只跑前置检查并打印将要执行的内容，不做任何写操作
  ./build_tag.sh --help     显示本帮助
USAGE
}

# 读取 JSON。用 node 而不是 jq，是为了和 release.yml 里
# `node -p "require('./manifest.json').version"` 保持同一套解析口径。
json_get() { # json_get <文件> <取值表达式，如 .version 或 .packages[''].version>
	node -p "const o = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')); o$2" -- "$1" 2>/dev/null || true
}

ASSUME_YES=0
DRY_RUN=0

while [ $# -gt 0 ]; do
	case "$1" in
		-y|--yes)     ASSUME_YES=1 ;;
		-n|--dry-run) DRY_RUN=1 ;;
		-h|--help)    usage; exit 0 ;;
		--)           shift; break ;;
		-*)           die "未知参数: $1" "用 --help 查看用法。" ;;
		*)            die "不接受位置参数: $1" "用 --help 查看用法。" ;;
	esac
	shift
done
[ $# -eq 0 ] || die "不接受位置参数: $*" "用 --help 查看用法。"

# ---- 检查 1: manifest.json 存在 ----
[ -f manifest.json ] || die "未找到 manifest.json" "请在仓库根目录运行本脚本。当前目录: $REPO_ROOT"

# ---- 检查 2: 解析版本号 ----
command -v node >/dev/null 2>&1 \
	|| die "未找到 node" "本脚本用 node 解析 manifest.json，请先安装 Node.js 22.18 或更高版本。"

VERSION="$(json_get manifest.json .version)"
[ -n "$VERSION" ] && [ "$VERSION" != "undefined" ] \
	|| die "无法从 manifest.json 读取 version 字段" "请确认该文件是合法 JSON 且包含 version。"

# ---- 检查 3: 版本号格式合法（必须在 git tag 之前）----
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	die "manifest.json 的 version 不是合法的语义化版本: $VERSION" \
		"期望形如 1.2.3（不带 v 前缀、不带 -beta 之类后缀），" \
		"因为 CI 会对 tag 名与 version 做字符串全等比较。"
fi

# ---- 检查 4: 在 git 仓库内 ----
git rev-parse --git-dir >/dev/null 2>&1 || die "当前目录不是 git 仓库" "路径: $REPO_ROOT"

# ---- 检查 5: 工作区干净（含未跟踪文件）----
if [ -n "$(git status --porcelain)" ]; then
	err "工作区有未提交的改动，已阻止打 tag"
	printf '\n' >&2
	git status --short | sed 's/^/  /' >&2
	cat >&2 <<'EOF'

  被 .gitignore 忽略的文件（如构建产物 main.js）不参与本检查。
  请先提交或暂存这些改动，然后重新运行：
    git add -A && git commit -m "..."    # 提交
    git stash push -u                    # 或先暂存起来
EOF
	exit 1
fi

# ---- 检查 6: 版本号在各文件间同步 ----
PKG_VERSION="$(json_get package.json .version)"
if [ -z "$PKG_VERSION" ]; then
	warn "无法读取 package.json 的 version，跳过该项一致性检查。"
elif [ "$PKG_VERSION" != "$VERSION" ]; then
	die "package.json 版本号是 ${PKG_VERSION}，与 manifest.json 的 ${VERSION} 不一致" \
		"发版前需同步以下文件：package.json / package-lock.json / versions.json"
fi

LOCK_VERSION="$(json_get package-lock.json .version)"
if [ "$LOCK_VERSION" != "$VERSION" ]; then
	die "package-lock.json 版本号是 ${LOCK_VERSION}，与 manifest.json 的 ${VERSION} 不一致" \
		"跑一次 npm install 即可同步 package-lock.json。"
fi

LOCK_ROOT_VERSION="$(json_get package-lock.json ".packages[''].version")"
if [ "$LOCK_ROOT_VERSION" != "$VERSION" ]; then
	die "package-lock.json 的 packages[\"\"].version 是 ${LOCK_ROOT_VERSION}，与 manifest.json 的 ${VERSION} 不一致" \
		"跑一次 npm install 即可同步 package-lock.json。"
fi

if ! node -e "process.exit(Object.prototype.hasOwnProperty.call(JSON.parse(require('node:fs').readFileSync('versions.json','utf8')), process.argv[1]) ? 0 : 1)" "$VERSION"; then
	MIN_APP_VERSION="$(json_get manifest.json .minAppVersion)"
	die "versions.json 中没有版本 $VERSION 的记录" \
		"请在 versions.json 中补充：\"$VERSION\": \"$MIN_APP_VERSION\""
fi

# ---- 检查 7: 本地无同名 tag / 同名分支 ----
if git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null 2>&1; then
	die "本地已存在 tag ${VERSION}（指向 $(git rev-parse --short "refs/tags/$VERSION")）" \
		"若只是补推：git push origin $VERSION" \
		"若要删除重打：git tag -d $VERSION"
fi

if git rev-parse -q --verify "refs/heads/$VERSION" >/dev/null 2>&1; then
	die "本地存在与版本号同名的分支 $VERSION" \
		"这会让 git push 报 refspec 歧义错误，请先重命名该分支。"
fi

# ---- 检查 8: 远端无同名 tag ----
# 注意：tag 不存在时 git ls-remote 输出为空但退出码为 0，必须判断输出而非退出码。
set +e
REMOTE_TAG="$(git ls-remote --tags origin "refs/tags/$VERSION" 2>/dev/null)"
LS_REMOTE_RC=$?
set -e
if [ "$LS_REMOTE_RC" -ne 0 ]; then
	warn "无法查询远端 tag（网络或权限问题），已跳过远端查重。"
elif [ -n "$REMOTE_TAG" ]; then
	die "远端 origin 已存在 tag $VERSION" \
		"无需重复推送；若确要重发，需先删除远端 tag。"
fi

# ---- 检查 9: 与 origin/main 的同步状态 ----
CURRENT_BRANCH="$(git symbolic-ref -q --short HEAD || true)"
if [ -z "$CURRENT_BRANCH" ]; then
	warn "当前处于 detached HEAD 状态，tag 会指向该游离提交。"
elif [ "$CURRENT_BRANCH" != "main" ]; then
	warn "当前分支是 ${CURRENT_BRANCH}，不是 main。"
fi

if ! git fetch --quiet origin main 2>/dev/null; then
	warn "无法从 origin 拉取 main，已跳过分支同步状态检查。"
elif ! git rev-parse -q --verify origin/main >/dev/null 2>&1; then
	warn "本地不存在 origin/main，已跳过分支同步状态检查。"
else
	BEHIND="$(git rev-list --count HEAD..origin/main)"
	AHEAD="$(git rev-list --count origin/main..HEAD)"
	if [ "$BEHIND" -gt 0 ] && [ "$AHEAD" -gt 0 ]; then
		die "本地分支与 origin/main 已分叉（领先 $AHEAD 个、落后 $BEHIND 个提交）" \
			"请先处理分叉再发布，例如：git pull --rebase origin main"
	fi
	if [ "$BEHIND" -gt 0 ]; then
		die "本地落后 origin/main $BEHIND 个提交" \
			"现在打 tag 会指向一个不含远端最新提交的旧提交。" \
			"请先执行：git pull --ff-only origin main"
	fi
	if [ "$AHEAD" -gt 0 ]; then
		warn "本地领先 origin/main $AHEAD 个提交（尚未推送）。"
		warn "tag 将指向本地提交，release CI 会用该提交构建。"
	fi
fi

# ---- 摘要 ----
COMMIT_SHA="$(git rev-parse --short HEAD)"
COMMIT_SUBJECT="$(git log -1 --pretty=%s)"

printf '\n将要执行：\n'
printf '  版本号     %s\n' "$VERSION"
printf '  目标提交   %s %s\n' "$COMMIT_SHA" "$COMMIT_SUBJECT"
printf '  git tag %s\n' "$VERSION"
printf '  git push origin %s\n' "$VERSION"
printf '\n推送后会触发 release workflow 并创建公开的 GitHub Release。\n\n'

if [ "$DRY_RUN" -eq 1 ]; then
	printf '%s(dry-run，未执行任何写操作)%s\n' "$C_DIM" "$C_RST"
	exit 0
fi

# ---- 确认 ----
if [ "$ASSUME_YES" -ne 1 ]; then
	if [ ! -t 0 ]; then
		die "当前不是交互终端，无法确认" "请加 --yes 跳过确认，或加 --dry-run 仅预览。"
	fi
	read -r -p "确认打 tag 并推送？输入 yes 继续，其它输入取消: " reply
	case "$reply" in
		y|Y|yes|YES|Yes) ;;
		*) die "已取消，未做任何改动。" ;;
	esac
fi

# ---- 执行 ----
if ! git tag "$VERSION"; then
	die "git tag $VERSION 执行失败" "若全局开启了 tag.gpgSign，请检查签名配置。"
fi
ok "已创建本地 tag $VERSION → $COMMIT_SHA"

if ! git push origin "$VERSION"; then
	err "推送 tag $VERSION 到 origin 失败。本地 tag 已保留，可二选一：" \
		"重试推送：git push origin $VERSION" \
		"撤销 tag：git tag -d $VERSION"
	exit 1
fi
ok "已推送 tag origin $VERSION"

# ---- 成功输出 ----
# 从 remote 地址推导仓库 slug，兼容 scp 形式（git@github.com:o/r.git）与 URL 形式。
# 推导不出来（例如远端是本机路径）就静默跳过链接，不影响脚本成功退出。
REMOTE_URL="$(git remote get-url origin 2>/dev/null || true)"
SLUG=""
case "$REMOTE_URL" in
	*github.com*)
		SLUG="${REMOTE_URL%.git}"
		case "$SLUG" in
			# https://github.com/o/r 与 ssh://git@github.com/o/r
			*://*) SLUG="${SLUG#*://}"; SLUG="${SLUG#*@}"; SLUG="${SLUG#*/}" ;;
			# scp 形式 git@github.com:o/r；也兼容 git@github.com-alias:o/r
			*@*:*) SLUG="${SLUG#*:}" ;;
		esac
		# 只接受 owner/repo 形状，其它一律跳过链接
		printf '%s' "$SLUG" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || SLUG=""
		;;
esac

printf '\n发布流程已触发\n'
if [ -n "$SLUG" ]; then
	printf '  CI 进度   https://github.com/%s/actions\n' "$SLUG"
fi
printf '  CI 会校验 tag 与 manifest.json 一致，跑测试与类型检查，构建 main.js 并创建 Release。\n'

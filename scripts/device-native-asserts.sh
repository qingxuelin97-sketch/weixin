#!/bin/sh
# M-I10 原生面断言 —— 在模拟器上驱动 SelfTestReceiver，逐项记 PASS/FAIL/WARN。
#
# 为什么是一个**文件**而不是 workflow 里的一段 script：
# `reactivecircus/android-emulator-runner` 的 `script:` 输入是**逐行**丢给
# `sh -c` 执行的，每行一个独立的 shell。于是 `NA=native-asserts.txt` 这样的赋值
# 活不到下一行，`: > "$NA"` 展开成 `: > ""`，报 `cannot create : Directory
# nonexistent` 直接把这一步打红——M-I10 的断言因此从来没有真正跑过，而 APK 其实
# 装上了、起来了、自检行也打出来了。函数定义（下面的 ck）同理活不过一行。
#
# 所以：所有需要跨行状态的东西都放进这个文件，workflow 里只留一行 `sh 这个文件`。
# 目标 shell 是 dash（POSIX），不要写 bashism；`set -o pipefail` 在 dash 里是
# Illegal option，会在安装前就杀掉整个 job。
set -eu

NA=native-asserts.txt
: > "$NA"
RECV=com.personal.weixinai/.aiwx.SelfTestReceiver
PKG=com.personal.weixinai

# POST_NOTIFICATIONS is a RUNTIME permission since Android 13 and is DENIED
# until the user taps 允许. Nobody taps anything on a headless emulator, so
# Notifier.canPost() was false and every notify path returned early — the run
# that first executed these assertions was measuring a blocked app, not a
# broken feature. Granting it here is exactly what the user does on a real
# phone; the permission FLOW itself is on the 真机验收清单 (an emulator cannot
# exercise a system dialog).
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS || true

# `dumpsys notification` prints, for EVERY installed package, an
# `AppSettings: <pkg>` line plus its channel list. So grepping the whole dump
# for our package name matches whether or not we ever posted anything — the
# old notify-record-posted did exactly that and reported PASS on a run where
# the Notification List held one record and it belonged to `pkg=android`.
# A false green in a blocking gate is worse than the two honest reds it sat
# next to, so posted-ness is now read ONLY from the Notification List section.
posted_record() {
  sed -n '/^  Notification List:/,/^  [A-Za-z]/p' "$1" | grep -q "pkg=$PKG"
}

# Posted records print their channel inline: `… Notification(channel=<id> …)`.
# Reading the channel off a LIVE record is what keeps these honest now that
# MainActivity registers both channels at launch — a bare `grep aiwx_calls`
# over the whole dump would match the registration and pass without anything
# ever having been posted, which is the trap that produced the false green.
posted_on_channel() {
  sed -n '/^  Notification List:/,/^  [A-Za-z]/p' "$1" | grep -q "channel=$2"
}

# ck <name> <severity-on-fail> <cmd…> — `if "$@"` 把探测放在受检上下文里，
# 这样 `set -e` 不会因为一次预期内的失败就中止整个脚本。
ck() {
  _n=$1
  _s=$2
  shift 2
  if "$@"; then
    echo "PASS $_n" >> "$NA"
  else
    echo "$_s $_n" >> "$NA"
  fi
}

# (1) 消息通知（带内联回复）：真的发出来了吗？
adb shell am broadcast -n "$RECV" -a com.personal.weixinai.selftest.NOTIFY || true
sleep 3
# --noredact prints the full record (some images redact notification content).
# The plain dump is appended too, so the evidence file stays useful when the
# flag is unsupported.
adb shell dumpsys notification --noredact > notif-dump.txt 2>/dev/null || true
adb shell dumpsys notification >> notif-dump.txt || true
ck notify-record-posted FAIL posted_record notif-dump.txt
# Split deliberately: 「频道注册了吗」 and 「真的发在那个频道上吗」 are different
# failures (missing channel vs. blocked app), and reading them apart is what
# turned this run from a guess into a diagnosis.
ck notify-channel-messages FAIL grep -q 'aiwx_messages' notif-dump.txt
ck notify-posted-on-messages FAIL posted_on_channel notif-dump.txt aiwx_messages
# dumpsys 常把 action 标题脱敏，这项只作参考。
ck notify-remoteinput-visible WARN grep -qi 'remoteinput\|remote_input' notif-dump.txt

# (2) RemoteInput 回环（绕开系统键盘）：合成回复 → SharedPreferences 队列 →
# 后台/前台弹跳 → JS 经正常发送路径排空（会打 AIWX-REPLYQ drained=…）。
adb shell am broadcast -n "$RECV" -a com.personal.weixinai.selftest.REPLY --es text ci-hello || true
sleep 2
adb shell input keyevent 3
sleep 5
adb shell am start -n com.personal.weixinai/.MainActivity
sleep 12

# (3) 来电全屏通知走自己的 channel。
adb shell am broadcast -n "$RECV" -a com.personal.weixinai.selftest.CALL || true
sleep 3
adb shell dumpsys notification --noredact > notif-dump2.txt 2>/dev/null || true
adb shell dumpsys notification >> notif-dump2.txt || true
ck call-channel-registered FAIL grep -q 'aiwx_calls' notif-dump2.txt
ck call-channel-posted FAIL posted_on_channel notif-dump2.txt aiwx_calls

# (4) 悬浮气泡：像用户在设置里那样授予 appop，再要一个气泡，看窗口列表。
adb shell appops set com.personal.weixinai SYSTEM_ALERT_WINDOW allow || true
adb shell am broadcast -n "$RECV" -a com.personal.weixinai.selftest.BUBBLE || true
sleep 3
adb shell dumpsys window windows > window-dump.txt || true
ck bubble-window-listed WARN grep -q 'com.personal.weixinai' window-dump.txt

# (5) 小组件 provider 渲染不崩（无头镜像没有 launcher 宿主，id 可能是 0，
# provider 两种情况都会打日志）。
adb shell am broadcast -n "$RECV" -a com.personal.weixinai.selftest.WIDGET || true
sleep 2

adb logcat -d > logcat-native.txt
ck replyq-enqueued FAIL grep -aq 'AIWX-REPLYQ.*enqueued' logcat-native.txt
ck replyq-js-drained FAIL grep -aq 'AIWX-REPLYQ drained=' logcat-native.txt
ck bubble-shown FAIL grep -aq 'AIWX-BUBBLE.*shown' logcat-native.txt
ck widget-rendered FAIL grep -aq 'AIWX-WIDGET.*render' logcat-native.txt
cat "$NA"

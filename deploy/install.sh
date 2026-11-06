#!/usr/bin/env bash
# Установка наблюдателя «Детектор АЭРО» на Linux / Raspberry Pi / VPS / Termux.
#
# Запуск из папки detector-aero:
#   bash deploy/install.sh              # systemd (нужен root) или пользовательская служба
#   bash deploy/install.sh --nohup      # без systemd: nohup + автозапуск через cron
#   bash deploy/install.sh --termux     # Android (Termux)
#
# После установки: systemctl status detector-aero  /  journalctl -u detector-aero -f
set -euo pipefail

MODE="auto"
for arg in "$@"; do
  case "$arg" in
    --nohup) MODE="nohup" ;;
    --termux) MODE="termux" ;;
    --auto) MODE="auto" ;;
    *) echo "Неизвестный параметр: $arg"; exit 2 ;;
  esac
done

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="detector-aero"

say() { printf '\033[1;32m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
die() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$SRC/watch.mjs" ] || die "Не найден $SRC/watch.mjs — запускайте скрипт из папки detector-aero."
[ -f "$SRC/config.json" ] || die "Не найден $SRC/config.json"

# ---------------------------------------------------------------- Node.js
install_node() {
  say "Node.js не найден, устанавливаю…"
  if [ "$MODE" = "termux" ] || [ -n "${TERMUX_VERSION:-}" ]; then
    pkg update -y >/dev/null 2>&1 || true
    pkg install -y nodejs
  elif command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y nodejs
  elif command -v yum >/dev/null 2>&1; then
    yum install -y nodejs
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache nodejs
  else
    die "Не удалось установить Node.js автоматически. Поставьте Node.js 18+ и повторите."
  fi
}

if ! command -v node >/dev/null 2>&1; then
  install_node
fi
NODE_BIN="$(command -v node)"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Нужен Node.js 18 или новее, установлен $("$NODE_BIN" -v)"
say "Node.js: $("$NODE_BIN" -v) ($NODE_BIN)"

# ---------------------------------------------------------------- каталог установки
if [ "$(id -u)" -eq 0 ] && [ "$MODE" != "termux" ]; then
  TARGET="/opt/${SERVICE_NAME}"
  RUN_USER="${SUDO_USER:-root}"
else
  TARGET="$HOME/${SERVICE_NAME}"
  RUN_USER="$(id -un)"
fi

mkdir -p "$TARGET"
for f in watch.mjs config.json README.md; do
  [ -f "$SRC/$f" ] && cp -f "$SRC/$f" "$TARGET/$f"
done
chmod 600 "$TARGET/config.json" 2>/dev/null || true
say "Файлы установлены в $TARGET"

# проверка, что всё работает до запуска службы
cd "$TARGET"
if ! "$NODE_BIN" watch.mjs --status >/dev/null 2>&1; then
  warn "Тестовый опрос не удался. Запустите вручную: cd $TARGET && node watch.mjs --status"
  warn "Частая причина — нет доступа в интернет или сменился формат API."
fi

# ---------------------------------------------------------------- Termux
if [ "$MODE" = "termux" ] || [ -n "${TERMUX_VERSION:-}" ]; then
  BOOT_DIR="$HOME/.termux/boot"
  mkdir -p "$BOOT_DIR"
  cat > "$BOOT_DIR/start-detector-aero.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
cd "$TARGET" && nohup "$NODE_BIN" watch.mjs >> "$TARGET/logs/termux.log" 2>&1 &
EOF
  chmod +x "$BOOT_DIR/start-detector-aero.sh"
  mkdir -p "$TARGET/logs"
  say "Установлено для Termux."
  echo
  echo "Дальше:"
  echo "  1) Установите приложение Termux:Boot из F-Droid (оно запускает скрипт при загрузке телефона)."
  echo "  2) Один раз откройте Termux:Boot, чтобы разрешить автозапуск."
  echo "  3) Запустить сейчас:  bash $BOOT_DIR/start-detector-aero.sh"
  echo "  4) Отключите оптимизацию батареи для Termux, иначе Android усыпит процесс."
  exit 0
fi

# ---------------------------------------------------------------- systemd
if [ "$MODE" != "nohup" ] && command -v systemctl >/dev/null 2>&1; then
  if [ "$(id -u)" -eq 0 ]; then
    UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
    cat > "$UNIT" <<EOF
[Unit]
Description=Detector AERO air threat watcher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${TARGET}
ExecStart=${NODE_BIN} ${TARGET}/watch.mjs
Restart=always
RestartSec=20
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now "${SERVICE_NAME}"
    say "Служба установлена и запущена: systemctl status ${SERVICE_NAME}"
    echo "Логи: journalctl -u ${SERVICE_NAME} -f"
  else
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Detector AERO air threat watcher
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${TARGET}
ExecStart=${NODE_BIN} ${TARGET}/watch.mjs
Restart=always
RestartSec=20

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "${SERVICE_NAME}"
    loginctl enable-linger "$RUN_USER" 2>/dev/null || warn "Не удалось включить linger — служба может останавливаться после выхода из системы."
    say "Пользовательская служба запущена: systemctl --user status ${SERVICE_NAME}"
    echo "Логи: journalctl --user -u ${SERVICE_NAME} -f"
  fi
  exit 0
fi

# ---------------------------------------------------------------- nohup + cron
mkdir -p "$TARGET/logs"
pkill -f "${TARGET}/watch.mjs" 2>/dev/null || true
cd "$TARGET"
nohup "$NODE_BIN" "$TARGET/watch.mjs" >> "$TARGET/logs/watch.out" 2>&1 &
START_LINE="@reboot cd $TARGET && nohup $NODE_BIN $TARGET/watch.mjs >> $TARGET/logs/watch.out 2>&1 &"
( crontab -l 2>/dev/null | grep -v 'watch.mjs' ; echo "$START_LINE" ) | crontab -
say "Запущено через nohup, автозапуск добавлен в crontab (@reboot)."
echo "Логи: tail -f $TARGET/logs/watch-$(date +%F).log"

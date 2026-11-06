# Установка на постоянно включённый хост

Наблюдатель — обычный Node.js‑скрипт, ему нужен только интернет. Подойдёт любой хост,
который не выключается: VPS за 150–300 ₽/мес, Raspberry Pi, старый ноутбук, мини-ПК,
Android-телефон с Termux.

## Вариант 1. VPS / Raspberry Pi / Linux-ноутбук

Скопируйте папку `detector-aero` на хост (например, через `scp -r` или WinSCP), затем:

```bash
cd detector-aero
sudo bash deploy/install.sh
```

Скрипт сам поставит Node.js (если его нет), создаст службу systemd с автоперезапуском
и включит её в автозагрузку.

```bash
systemctl status detector-aero      # состояние
journalctl -u detector-aero -f      # логи в реальном времени
sudo systemctl restart detector-aero
```

Если systemd нет, используйте `bash deploy/install.sh --nohup` — запустит через nohup
и добавит автозапуск в crontab.

## Вариант 2. Android-телефон или планшет (Termux)

1. Установите **Termux** и **Termux:Boot** из F-Droid.
2. В Termux: `pkg update && pkg install -y nodejs openssh` (или скопируйте папку иначе).
3. Скопируйте папку `detector-aero` в домашний каталог Termux.
4. Выполните:

```bash
cd ~/detector-aero
bash deploy/install.sh --termux
```

5. Откройте Termux:Boot один раз, чтобы разрешить автозапуск.
6. В настройках Android отключите оптимизацию батареи для Termux — иначе система усыпит процесс.

## Вариант 3. Windows-ноутбук, который всегда включён

Уже настроено: задача Планировщика `DetectorAeroWatch` + `install-autostart.ps1`.
Достаточно, чтобы ноутбук не уходил в сон (Параметры → Система → Питание).

## После установки

Проверка, что уведомления доходят:

```bash
cd /opt/detector-aero      # или ~/detector-aero
node watch.mjs --test
```

Настройки — в `config.json` рядом со скриптом: зоны, радиус, типы угроз, каналы.
После правки конфига службу нужно перезапустить (`systemctl restart detector-aero`).

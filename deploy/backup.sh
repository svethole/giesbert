#!/bin/sh
# Tägliche Sicherung der Giesbert-Datenbank (Pflanzen + Bilder), behält die letzten 60 Tage.
# Einrichten (als root):  sudo crontab -e  →  25 3 * * * /var/www/giesbert/deploy/backup.sh
set -eu
SRC=/var/lib/giesbert/giesbert.db
DEST=/var/backups/giesbert
mkdir -p "$DEST"
chmod 700 "$DEST"
FILE="$DEST/giesbert-$(date +%F).db"
# Konsistente Kopie auch während der Server läuft
python3 -c "import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()" "$SRC" "$FILE"
find "$DEST" -name 'giesbert-*.db' -mtime +60 -delete

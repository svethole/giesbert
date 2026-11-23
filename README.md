# Giesbert 💧

Eine kleine Web-App, die Dich ans Gießen Deiner Zimmerpflanzen erinnert – und sonst an nichts.
Kein Standort, kein Topfdurchmesser, keine Lichtmessung, kein schlechtes Gewissen.

Ziel: `https://giesbert.svetho.net`

## Funktionen

- Pflanzen per deutschem Namen oder lateinischem Binom hinzufügen. Die eingebaute Datenbank kennt ca. 100 Zimmerpflanzen und verzeiht Tippfehler.
- Unbekannte Pflanzen: Online-Suche über die freie [GBIF-API](https://www.gbif.org/developer/species) (ohne Schlüssel) oder einfach „so anlegen“.
- **Bilder:** Neue Pflanzen bekommen automatisch ein Foto aus Wikipedia bzw. Wikimedia Commons, mit Urheber- und Lizenzangabe. Alternativ lässt sich pro Pflanze ein eigenes Foto hochladen, am Handy auch direkt mit der Kamera.
- Das Gießintervall passt sich automatisch an die Jahreszeit an (im Winter seltener) und lässt sich per +/− anpassen.
- „Gegossen“, „Alle gegossen“ und „Morgen nochmal“ (wenn die Erde noch feucht ist), jeweils mit Rückgängig.
- Dezenter Hinweis „Dünger wäre mal wieder nett“, nur März–September und pro Pflanze abschaltbar.
- Erinnerung als wiederkehrender Kalendertermin (`.ics`), optional Browser-Mitteilungen und App-Badge.
- Alle Daten liegen in einer SQLite-Datenbank auf dem Server – auf jedem Gerät dieselben. Fällt die Verbindung kurz aus, merkt sich die App die Änderungen und trägt sie nach.
- Lässt sich am Handy installieren (PWA), hell & dunkel.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `server.py` | Kleiner Python-Server (nur Standardbibliothek): liefert die App aus, JSON-Schnittstelle unter `/api/`, holt Bilder von Wikipedia |
| `public/` | Die Weboberfläche |
| `public/plants.js` | Pflegedatenbank (Gießabstände, Düngeabstände, Tipps) |
| `public/app.js` | Programmlogik im Browser |
| `deploy/` | systemd-Dienst, nginx-Konfiguration, Sicherungsskript |

Die Datenbank (Standard: `data/giesbert.db`, auf dem Server `/var/lib/giesbert/giesbert.db`) enthält drei Tabellen: `plants` (die Pflanzen), `images` (Fotos samt Bildnachweis) und `waterings` (Gieß-Verlauf).

## Lokal testen

```sh
python3 server.py            # → http://127.0.0.1:8090
```

---

## Einrichtung auf dem eigenen Server

Die Befehle gehen von Debian/Ubuntu mit nginx aus (wie bei den anderen Projekten auf dem Hostinger-Server).

Der Projektordner `/var/www/giesbert` gehört dem normalen Benutzer `svetho`. Darum laufen `git clone` und `git pull` **ohne** `sudo` – und nutzen so auch dessen SSH-Schlüssel. `sudo` braucht es nur für Pakete, systemd, nginx und certbot. Der Dienst selbst läuft als eigener Systembenutzer ohne Anmeldung (`DynamicUser`) und darf nur in `/var/lib/giesbert` schreiben.

> **Schon die erste (rein statische) Fassung im Einsatz?** Dann direkt zu [Umstieg auf die Datenbank-Fassung](#umstieg-auf-die-datenbank-fassung) springen.

### 1. DNS-Eintrag prüfen

Die Subdomain muss auf den Server zeigen. Beim DNS-Anbieter von `svetho.net`:

| Typ | Name | Wert |
|---|---|---|
| `A` | `giesbert` | IPv4-Adresse des Servers |
| `AAAA` | `giesbert` | IPv6-Adresse des Servers (nur falls vorhanden) |

Alternativ ein `CNAME` von `giesbert` auf `svetho.net`, wenn die Hauptdomain auf denselben Server zeigt. Prüfen, ob er schon greift:

```sh
dig +short giesbert.svetho.net
```

### 2. Dateien holen

```sh
sudo apt install git python3 nginx certbot python3-certbot-nginx apache2-utils
sudo mkdir /var/www/giesbert && sudo chown svetho: /var/www/giesbert
git clone git@github.com:svethole/giesbert.git /var/www/giesbert
```

Wichtig: `git clone` **ohne** `sudo` – sonst sucht git den SSH-Schlüssel bei root (`/root/.ssh/`) und meldet „Permission denied (publickey)“.

Der Benutzer `svetho` braucht dafür einen SSH-Schlüssel, den GitHub kennt. Prüfen lässt sich das (ebenfalls ohne `sudo`) mit `ssh -T git@github.com`: Kommt „Hi …! You've successfully authenticated“, passt alles.
Wurde das Repo schon per https geklont, lässt es sich nachträglich umstellen:

```sh
git -C /var/www/giesbert remote set-url origin git@github.com:svethole/giesbert.git
```

### 3. Dienst einrichten und starten

```sh
sudo cp /var/www/giesbert/deploy/giesbert.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now giesbert
systemctl status giesbert            # sollte „active (running)“ zeigen
curl -s http://127.0.0.1:8090/api/plants   # → {"plants": []}
```

Optional: Wikimedia bittet darum, dass sich Programme mit einer Kontaktmöglichkeit ausweisen. Dafür `deploy/giesbert.env.example` nach `/etc/giesbert.env` kopieren, die Zeile anpassen und einkommentieren, dann `sudo chmod 600 /etc/giesbert.env && sudo systemctl restart giesbert`.

### 4. Passwort festlegen

Weil die Pflanzen und Fotos jetzt auf dem Server liegen, ist die Seite mit Benutzername und Passwort geschützt:

```sh
sudo htpasswd -c /etc/nginx/htpasswd-giesbert DEINNAME
```

(`-c` legt die Datei neu an – für weitere Benutzer ohne `-c` aufrufen.)

### 5. nginx einrichten

```sh
sudo cp /var/www/giesbert/deploy/nginx-giesbert.conf /etc/nginx/sites-available/giesbert
sudo ln -s /etc/nginx/sites-available/giesbert /etc/nginx/sites-enabled/giesbert
sudo nginx -t && sudo systemctl reload nginx
```

### 6. HTTPS einschalten

```sh
sudo certbot --nginx -d giesbert.svetho.net
```

Certbot ergänzt die HTTPS-Einstellungen und die Umleitung von http auf https selbst. **HTTPS ist Pflicht:** Ohne HTTPS funktionieren weder der Offline-Betrieb noch das Installieren am Handy – und das Passwort ginge unverschlüsselt durchs Netz.

### 7. Tägliche Sicherung

```sh
sudo crontab -e
```

und diese Zeile ergänzen:

```
25 3 * * * /var/www/giesbert/deploy/backup.sh
```

Jede Nacht um 3:25 Uhr landet dann eine Kopie der Datenbank (inklusive aller Bilder) in `/var/backups/giesbert/`. Sicherungen älter als 60 Tage werden gelöscht. Einmal von Hand ausprobieren:

```sh
sudo /var/www/giesbert/deploy/backup.sh && sudo ls -la /var/backups/giesbert
```

### 8. Ausprobieren

- https://giesbert.svetho.net aufrufen, anmelden und eine Pflanze anlegen – nach ein, zwei Sekunden sollte ihr Foto erscheinen.
- Auf eine Pflanze tippen → „📷 Eigenes Foto“ zum Hochladen.
- Am Handy: im Browser-Menü „Zum Home-Bildschirm“ bzw. „App installieren“ wählen.
- In den Einstellungen (⚙️) den Kalendertermin herunterladen und in den eigenen Kalender importieren.

---

## Umstieg auf die Datenbank-Fassung

Für alle, bei denen schon die erste, rein statische Fassung läuft (nginx liefert dort `public/` direkt aus).

1. **Sicherheitshalber** in der laufenden App unter ⚙️ → „Exportieren“ eine Sicherungsdatei speichern.
2. Neue Fassung holen:

   ```sh
   cd /var/www/giesbert && git pull
   ```

3. Schritte [3. Dienst](#3-dienst-einrichten-und-starten), [4. Passwort](#4-passwort-festlegen) und [5. nginx](#5-nginx-einrichten) ausführen. Beim `ln -s` meldet sich ein „File exists“ – das ist in Ordnung, die Verknüpfung gibt es ja schon.
4. Weil die nginx-Datei ersetzt wurde, sind die HTTPS-Ergänzungen von Certbot weg. Also noch einmal:

   ```sh
   sudo certbot --nginx -d giesbert.svetho.net
   ```

   Fragt Certbot, was mit dem vorhandenen Zertifikat passieren soll, „1: Attempt to reinstall this existing certificate“ wählen.
5. Schritt [7. Sicherung](#7-tägliche-sicherung) einrichten.
6. Die App **auf dem Gerät öffnen, auf dem die Pflanzen bisher gespeichert waren**. Sie zieht sie beim ersten Start automatisch in die Datenbank um („… Pflanzen in die Datenbank übernommen 🎉“) und sucht für jede ein Foto. Ab dann sind sie auf allen Geräten da.

   Hat das nicht geklappt, lässt sich die Sicherungsdatei aus Schritt 1 unter ⚙️ → „Importieren“ einspielen.

---

## Aktualisieren

```sh
cd /var/www/giesbert && git pull && sudo systemctl restart giesbert
```

Hat sich `deploy/giesbert.service` geändert, die Datei erneut nach `/etc/systemd/system/` kopieren und `sudo systemctl daemon-reload` ausführen.
Hat sich `deploy/nginx-giesbert.conf` geändert, die Datei erneut mit `sudo cp` nach `/etc/nginx/sites-available/giesbert` kopieren und danach `sudo certbot --nginx -d giesbert.svetho.net` noch einmal ausführen (siehe oben).

## Wiederherstellen aus einer Sicherung

```sh
sudo systemctl stop giesbert
sudo cp /var/backups/giesbert/giesbert-JJJJ-MM-TT.db /var/lib/giesbert/giesbert.db
sudo rm -f /var/lib/giesbert/giesbert.db-wal /var/lib/giesbert/giesbert.db-shm
sudo systemctl start giesbert
```

(`/var/lib/giesbert` ist bei `DynamicUser` ein Verweis auf `/var/lib/private/giesbert` – das ist so gewollt.)

## Fehlersuche

```sh
journalctl -u giesbert -n 50                 # Meldungen des Dienstes
sudo nginx -t                                # Konfiguration in Ordnung?
sudo tail -n 50 /var/log/nginx/error.log     # Meldungen von nginx
curl -s http://127.0.0.1:8090/api/plants     # Antwortet der Dienst direkt?
```

- **„502 Bad Gateway“:** Der Dienst läuft nicht – `systemctl status giesbert` und `journalctl -u giesbert` anschauen.
- **Gelber Hinweis „Keine Verbindung zum Server“:** Die App erreicht `/api/` nicht. Änderungen gehen nicht verloren, sie werden nachgetragen, sobald der Server wieder antwortet.
- **Kein Bild gefunden:** Nicht jede Pflanze hat einen Wikipedia-Artikel mit Foto. Dann einfach ein eigenes Foto hochladen. Schlägt die Suche immer fehl, prüfen, ob der Server Wikipedia erreicht: `curl -sI https://de.wikipedia.org | head -1`.
- **Seite bleibt weiß:** In der Browser-Konsole (F12) nach Meldungen zur „Content-Security-Policy“ schauen.
- **Online-Suche (GBIF) geht nicht:** Die CSP muss `connect-src … https://api.gbif.org` erlauben (steht so in der Konfiguration).

---

## Daten, Bilder & Datenschutz

- Pflanzen, Fotos und Gieß-Verlauf liegen in **einer** Datei: `/var/lib/giesbert/giesbert.db`. Die nächtliche Sicherung kopiert sie komplett.
- ⚙️ → „Exportieren“ speichert zusätzlich die Pflanzenliste als JSON-Datei (ohne Bilder). „Importieren“ spielt so eine Datei wieder ein: Pflanzen mit gleicher Kennung werden überschrieben, alle anderen bleiben.
- Gelöschte Pflanzen landen 30 Tage im Papierkorb der Datenbank (dafür gibt es „Rückgängig“) und werden danach beim nächsten Start des Dienstes endgültig entfernt.
- Eigene Fotos werden schon im Browser auf höchstens 1200 Pixel verkleinert und bleiben auf Deinem Server.
- Für automatische Bilder fragt **der Server** (nicht Dein Browser) bei `de.wikipedia.org`, `en.wikipedia.org` und `commons.wikimedia.org` nach dem Pflanzennamen und lädt das Bild herunter. Die Bilder stehen unter freien Lizenzen; Urheber und Lizenz zeigt die App beim Bild an (auf die Pflanze tippen).
- Die Online-Namenssuche schickt nur den eingetippten Pflanzennamen an `api.gbif.org`, sonst nichts.

## Pflegewerte anpassen

Die Datenbank steht in `public/plants.js`. Jeder Eintrag sieht so aus:

```js
{l:["Spathiphyllum wallisii"], d:["Einblatt","Friedenslilie"], s:5, w:8, f:14, h:"Kurzer Tipp"},
```

| Feld | Bedeutung |
|---|---|
| `l` | Lateinische Namen (erster = Hauptname, weitere = Synonyme) |
| `d` | Deutsche Namen |
| `s` | Gießabstand im Sommer (April–September) in Tagen |
| `w` | Gießabstand im Winter (November–Februar) in Tagen; März und Oktober liegen dazwischen |
| `f` | Düngeabstand in Tagen (März–September), `0` = nie düngen |
| `h` | Kurzer Tipp (optional) |

Die Werte gelten beim Anlegen einer Pflanze und werden dann in der Datenbank gespeichert. Die Werte sind Richtwerte für normale Wohnräume. Die Fingerprobe hat immer Recht. 🙂

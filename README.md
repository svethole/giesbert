# Giesbert 💧

Eine kleine Web-App, die Dich ans Gießen Deiner Zimmerpflanzen erinnert – und sonst an nichts.
Kein Standort, kein Topfdurchmesser, keine Lichtmessung, kein schlechtes Gewissen.

Ziel: `https://giesbert.svetho.net`

## Funktionen

- Pflanzen per deutschem Namen oder lateinischem Binom hinzufügen. Die eingebaute Datenbank kennt ca. 100 Zimmerpflanzen und verzeiht Tippfehler.
- Unbekannte Pflanzen: Online-Suche über die freie [GBIF-API](https://www.gbif.org/developer/species) (ohne Schlüssel) oder einfach „so anlegen“.
- Das Gießintervall passt sich automatisch an die Jahreszeit an (im Winter seltener) und lässt sich per +/− anpassen.
- „Gegossen“, „Alle gegossen“ und „Morgen nochmal“ (wenn die Erde noch feucht ist), jeweils mit Rückgängig.
- Dezenter Hinweis „Dünger wäre mal wieder nett“, nur März–September und pro Pflanze abschaltbar.
- Erinnerung als wiederkehrender Kalendertermin (`.ics`), optional Browser-Mitteilungen und App-Badge.
- Export/Import als JSON. Läuft offline, lässt sich am Handy installieren (PWA), hell & dunkel.

Die Seite ist rein statisch: kein PHP, keine Datenbank, kein Build-Schritt. Die Pflanzen werden **nur im Browser** gespeichert (`localStorage`), der Server liefert bloß die Dateien aus.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `public/` | Die App selbst – nur dieser Ordner ist von außen erreichbar |
| `public/plants.js` | Pflegedatenbank (Gießabstände, Düngeabstände, Tipps) |
| `public/app.js` | Programmlogik |
| `public/sw.js` | Service Worker für Offline-Betrieb |
| `deploy/nginx-giesbert.conf` | nginx-Konfiguration für den Server |

## Lokal testen

```sh
cd public
python3 -m http.server 8000      # → http://localhost:8000
```

---

## Einrichtung auf dem eigenen Server

Die Befehle gehen von Debian/Ubuntu mit nginx aus (wie bei den anderen Projekten auf dem Hostinger-Server) und werden als root (bzw. mit `sudo`) ausgeführt.

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
apt install git nginx certbot python3-certbot-nginx
git clone https://github.com/svethole/giesbert.git /var/www/giesbert
```

Einen Dienst braucht es nicht – nginx liefert die Dateien direkt aus `/var/www/giesbert/public` aus.

### 3. nginx einrichten

```sh
cp /var/www/giesbert/deploy/nginx-giesbert.conf /etc/nginx/sites-available/giesbert
ln -s /etc/nginx/sites-available/giesbert /etc/nginx/sites-enabled/giesbert
nginx -t && systemctl reload nginx
```

Jetzt sollte http://giesbert.svetho.net die App zeigen.

### 4. HTTPS einschalten

```sh
certbot --nginx -d giesbert.svetho.net
```

Certbot ergänzt die HTTPS-Einstellungen und die Umleitung von http auf https selbst. **HTTPS ist Pflicht:** Ohne HTTPS funktionieren weder der Offline-Betrieb noch das Installieren am Handy.

### 5. Ausprobieren

- https://giesbert.svetho.net aufrufen und eine Pflanze anlegen.
- Am Handy: im Browser-Menü „Zum Home-Bildschirm“ bzw. „App installieren“ wählen.
- In den Einstellungen (⚙️) den Kalendertermin herunterladen und in den eigenen Kalender importieren.

### Passwortschutz (optional)

Eigentlich nicht nötig: Auf dem Server liegen keine persönlichen Daten, nur die App. Wer die Seite trotzdem nicht öffentlich haben will:

```sh
apt install apache2-utils
htpasswd -c /etc/nginx/htpasswd-giesbert DEINNAME
```

Dann in `/etc/nginx/sites-available/giesbert` die beiden Zeilen `auth_basic …` einkommentieren (das `#` entfernen) und `nginx -t && systemctl reload nginx` ausführen. Die App ist dafür vorbereitet (das Manifest wird mit Anmeldedaten geladen), am Handy muss man sich dann aber gelegentlich neu anmelden.

### Aktualisieren

```sh
cd /var/www/giesbert && git pull
```

Mehr ist nicht nötig – kein Neustart. Weil nginx `Cache-Control: no-cache` schickt, holt sich der Browser die neue Fassung beim nächsten Öffnen.
Hat sich `deploy/nginx-giesbert.conf` geändert, die Datei erneut nach `/etc/nginx/sites-available/giesbert` kopieren. **Achtung:** Dabei gehen die Ergänzungen von Certbot verloren – also danach `certbot --nginx -d giesbert.svetho.net` noch einmal ausführen (Certbot nimmt das vorhandene Zertifikat).

### Fehlersuche

```sh
nginx -t                                     # Konfiguration in Ordnung?
tail -n 50 /var/log/nginx/error.log          # Meldungen von nginx
curl -I https://giesbert.svetho.net          # Antwortet der Server, stimmen die Header?
```

- **Seite bleibt weiß:** In der Browser-Konsole (F12) nach Meldungen zur „Content-Security-Policy“ schauen.
- **Online-Suche geht nicht:** Die CSP muss `connect-src … https://api.gbif.org` erlauben (steht so in der Konfiguration).
- **Alte Fassung wird angezeigt:** Seite einmal neu laden; notfalls in den Browser-Einstellungen die Website-Daten löschen. **Vorher exportieren**, sonst sind die Pflanzen weg!

---

## Daten & Sicherung

Alles bleibt im Browser des jeweiligen Geräts – es gibt kein Konto und keine Synchronisation.
Darum ab und zu über ⚙️ → „Exportieren“ eine Sicherung machen. Über „Importieren“ lassen sich die Pflanzen auch auf ein anderes Gerät übertragen.

Die Online-Suche schickt nur den eingetippten Pflanzennamen an `api.gbif.org`, sonst nichts.

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

Die Werte sind Richtwerte für normale Wohnräume. Die Fingerprobe hat immer Recht. 🙂

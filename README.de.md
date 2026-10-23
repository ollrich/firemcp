# FireMCP

[![Release](https://img.shields.io/github/v/release/ollrich/firemcp)](https://github.com/ollrich/firemcp/releases/latest)
[![Lizenz: MIT](https://img.shields.io/github/license/ollrich/firemcp)](LICENSE)

[English](README.md) | Deutsch

FireMCP lässt deinen KI-Assistenten dein echtes Firefox lesen: offene Tabs, fertig gerenderte Seiten, Suche in Seiten, Verlauf, Lesezeichen und Screenshots. Es besteht aus einem Firefox-Add-on und einem lokalen MCP-Server und funktioniert damit mit Claude Desktop, Claude Code und anderen MCP-Clients.

Es liest, was du ohnehin im Browser siehst, auch Seiten hinter einem Login und Seiten, die erst mit JavaScript entstehen, wo ein einfacher Webabruf veraltete oder leere Inhalte liefert. Es kann Tabs öffnen, schließen und ordnen, klickt und tippt aber nie auf Seiten, schickt keine Formulare ab und führt dort keine eigenen Skripte aus.

## Werkzeuge

**Seiten lesen**

| Werkzeug | Was es tut |
|----------|------------|
| `read-tab` | Liest einen offenen Tab, gefunden über einen Teil von Adresse oder Titel, über die Tab-ID oder den aktiven Tab |
| `read-tabs` | Liest mehrere offene Tabs in einem Aufruf |
| `open-and-read-tab` | Öffnet eine Adresse, wartet, bis die Seite fertig ist, und gibt ihren Text zurück |
| `open-and-read-tabs` | Öffnet mehrere Adressen in Hintergrund-Tabs, liest sie und schließt sie wieder |
| `search-tab` | Sucht Text in einem Tab und liefert Fundstellen mit Position |
| `read-page-meta` | Meta-Tags, Open Graph, JSON-LD und Überschriften einer Seite |
| `read-selection` | Den Text, den du in einem Tab markiert hast |
| `get-tab-web-content` | Ganzer Text und Links eines Tabs (das ursprüngliche Basiswerkzeug) |
| `capture-tab-screenshot` | Screenshot vom sichtbaren Teil eines Tabs |

Die Lesewerkzeuge liefern kompakten Text, ohne Vorgabe bis zu 40.000 Zeichen pro Aufruf, mit der Position zum Weiterlesen. Optionen: `format: "markdown"` behält Überschriften, Listen, Links und Tabellen, `mainContentOnly` lässt Navigation und Seitenleisten weg, `selector` und `excludeSelector` wählen Teile einer Seite, und `redactPersonalData` schwärzt E-Mail-Adressen, Telefonnummern, IBANs und Kartennummern.

**Browserdaten**

| Werkzeug | Was es tut |
|----------|------------|
| `get-list-of-open-tabs` | Offene Tabs mit Zustand (aktiv, entladen, lädt), filter- und sortierbar |
| `get-current-tab` | Der Tab, den du gerade ansiehst |
| `get-tab-metadata` | Details zu einem Tab |
| `get-recent-browser-history` | Besuchte Seiten, neueste zuerst, gefiltert nach Wörtern und Alter |
| `search-bookmarks` | Lesezeichen mit Ordnerpfad und Datum |

**Tabs**

| Werkzeug | Was es tut |
|----------|------------|
| `open-browser-tab` | Öffnet eine Seite in einem neuen Tab |
| `close-browser-tabs` | Schließt Tabs |
| `reorder-browser-tabs` | Ändert die Reihenfolge der Tabs |
| `group-browser-tabs` | Fasst Tabs zu einer Gruppe mit Name und Farbe zusammen |
| `find-highlight-in-browser-tab` | Sucht und markiert Text in einem Tab |

## Was du in der Hand behältst

- **Nur lokal.** Das Add-on spricht über `127.0.0.1` und `::1` mit dem MCP-Server auf deinem Computer und nimmt nur Befehle an, die mit einem geheimen Schlüssel signiert sind, den nur die beiden kennen. FireMCP hat keinen eigenen Server und sammelt keine Nutzungsdaten.
- **Zustimmung pro Website.** Das Add-on liest eine Seite erst, wenn du ihre Website einmal erlaubt hast. Verlauf, Lesezeichen und die Suche auf der Seite sind optionale Berechtigungen, nach denen beim ersten Gebrauch gefragt wird. Ein Screenshot braucht einen Klick auf den FireMCP-Button in diesem Tab.
- **Sperrliste.** Websites auf der Liste werden nie gelesen oder geöffnet und fehlen in Verlauf und Lesezeichen.
- **Schalter und Protokoll.** Jedes Werkzeug lässt sich in den Einstellungen des Add-ons abschalten, und dort stehen die letzten 100 Aktionen.

Dein Assistent sieht alles, was er liest. Seiten können Text enthalten, der KI-Assistenten in die Irre führen soll. Behalte deshalb im Blick, was dein Assistent mit deinem Browser macht, wie bei jedem MCP-Server.

## Installation

Du brauchst Firefox 140 oder neuer.

### 1. Firefox-Add-on

Öffne das [neueste Release](https://github.com/ollrich/firemcp/releases/latest) in Firefox und klicke auf `firemcp-<version>.xpi`. Das Add-on ist von Mozilla signiert und aktualisiert sich selbst. Nach der Installation öffnet sich seine Einstellungsseite mit dem geheimen Schlüssel, den der MCP-Server braucht.

### 2. MCP-Server

**Claude Desktop:** Lade `firemcp-<version>.dxt` aus demselben Release herunter und öffne die Datei, oder zieh sie in die Erweiterungen in den Einstellungen von Claude Desktop. Trag den geheimen Schlüssel unter "Konfigurieren" ein und schalte die Erweiterung ein.

**Claude Code** (braucht Node.js 22 oder neuer):

```bash
git clone https://github.com/ollrich/firemcp.git
cd firemcp
npm install
npm run build
claude mcp add firemcp --scope user -e EXTENSION_SECRET=<Schlüssel> -- node "$PWD/mcp-server/dist/server.js"
```

**Andere MCP-Clients:** Wie oben bauen, dann den Server in die Konfiguration des Clients eintragen:

```json
{
  "mcpServers": {
    "firemcp": {
      "command": "node",
      "args": ["/pfad/zu/firemcp/mcp-server/dist/server.js"],
      "env": { "EXTENSION_SECRET": "<Schlüssel>" }
    }
  }
}
```

Die Verbindung zum Add-on steht wenige Sekunden nach dem Start des Servers.

### Einstellungen

| Variable | Vorgabe | Bedeutung |
|----------|---------|-----------|
| `EXTENSION_SECRET` | (Pflicht) | Geheimer Schlüssel von der Einstellungsseite des Add-ons |
| `EXTENSION_PORT` | `8089` | Port für die Verbindung zum Add-on, muss zu den Einstellungen des Add-ons passen |
| `BROWSER_MCP_TOOLS` | `all` | `all`, `read` (nur lesende Werkzeuge plus Seiten öffnen) oder eine kommagetrennte Liste von Werkzeugnamen |
| `BROWSER_MCP_DEBUG` | aus | `1` schreibt ein ausführliches Protokoll nach stderr |

### Mehrere MCP-Clients

Mehrere Clients können gleichzeitig dasselbe Firefox nutzen, zum Beispiel Claude Desktop und einige Claude-Code-Sitzungen. Der erste Serverprozess für einen Port und Schlüssel hält die Verbindung zum Add-on, weitere Prozesse mit denselben Werten reichen ihre Aufrufe an ihn weiter. Ein zweiter Browser oder ein anderes Firefox-Profil bekommt einen eigenen Port und Schlüssel.

### Das ursprüngliche Add-on

FireMCP ist aus [Browser Control MCP](https://github.com/eyalzh/browser-control-mcp) entstanden. Der Server funktioniert auch mit diesem Add-on von addons.mozilla.org, mit weniger Funktionen: kein Markdown, keine Selektoren, keine Seitendetails, kein markierter Text und keine Lesezeichen. Werkzeuge, die das FireMCP-Add-on brauchen, sagen das.

## Beispiele

- *"Lies den offenen Jira-Tab und liste die Tickets auf, die mir zugewiesen sind."*
- *"Such in meinem Verlauf den Artikel über Nachtzüge von letzter Woche und fass ihn zusammen."*
- *"Öffne die drei neuesten Ergebnisse auf der Konferenzseite und vergleiche ihre Fristen."*

## Entwicklung

```bash
npm install
npm run build   # MCP-Server und Add-on, die XPI landet in firefox-extension/web-ext-artifacts
npm test        # Servertests (node:test) und Add-on-Tests (Jest)
```

- `mcp-server`: der MCP-Server (TypeScript, Node.js)
- `firefox-extension`: das Firefox-Add-on (Manifest V2), Texte in `_locales/en` und `_locales/de`
- `common`: Nachrichtentypen, die beide nutzen

Für einen Test ohne Signierung lädst du `firefox-extension/manifest.json` in `about:debugging` als temporäres Add-on. Architektur, Projektregeln und der Ablauf für Releases stehen (auf Englisch) in [AGENTS.md](AGENTS.md).

## Credits

FireMCP baut auf der Arbeit anderer auf:

- **[Eyal Zach (eyalzh)](https://github.com/eyalzh/browser-control-mcp)** hat Browser Control MCP geschrieben, den MCP-Server und das Firefox-Add-on, aus denen dieses Projekt entstanden ist, samt dem Screenshot-Werkzeug ([eyalzh/browser-control-mcp#59](https://github.com/eyalzh/browser-control-mcp/pull/59)).
- **[Kostiantyn Kugot (kkugot)](https://github.com/kkugot/browser-control-mcp)** hat den Singleton-Broker ergänzt, über den sich mehrere MCP-Clients einen Browser teilen, sowie die Werkzeuge `get-current-tab` und `get-tab-metadata`, nach Pull Requests von [dsdshcym](https://github.com/eyalzh/browser-control-mcp/pull/44) und [Alex Kapranoff](https://github.com/eyalzh/browser-control-mcp/pull/41).

Ihre vollständige Historie ist Teil dieses Repositorys. FireMCP selbst pflegt [Oliver Eichhof (ollrich)](https://github.com/ollrich).

## Lizenz

[MIT](LICENSE). Firefox ist eine Marke der Mozilla Foundation, FireMCP steht in keiner Verbindung zu Mozilla.

---
name: model-router
description: Sceglie il modello Claude più adatto (Haiku, Sonnet, Opus, Fable) per ogni compito, con criteri di efficienza ed efficacia e l'obiettivo di ridurre il consumo di token. Usala all'inizio di ogni compito, prima di delegare a un subagent, e quando un compito cambia di complessità.
---

# Model Router

Obiettivo: **risultato corretto al minor costo in token.** Il costo si misura per compito completato, non per singola richiesta: un modello economico che sbaglia e va rifatto costa di più.

## Limite da conoscere

Claude non può cambiare il modello della sessione principale da solo. Leve disponibili:
1. **Subagent**: `Agent` con parametro `model` (`haiku` | `sonnet` | `opus` | `fable`). È la leva principale.
2. **Sessione principale**: se il modello attuale è palesemente sovra/sotto-dimensionato per un compito lungo, suggerire all'utente in una riga di usare `/model <nome>`. Non insistere.

## Tabella di scelta

| Modello | Costo $/1M token (in/out) | Usalo per |
|---|---|---|
| **haiku** | 0,10 / 0,50 | Cercare file e testo, leggere e riassumere, estrarre dati, classificare, formattare, tradurre testi semplici, comandi git/shell ripetitivi, controlli rapidi, domande fattuali brevi |
| **sonnet** | 2 / 10 | Coding quotidiano, bug circoscritti, feature di media misura, test, refactor locali, documentazione, email e testi professionali, analisi dati standard |
| **opus** | 4 / 20 | Architettura e decisioni tecniche, debug difficile su più file, sicurezza, code review critica, questioni legali/fiscali/finanziarie/contrattuali, pianificazione di compiti lunghi, task agentici multi-step |
| **fable** | 10 / 50 | Solo se opus ha fallito o il problema è eccezionalmente difficile e di lunga durata. Chiedere conferma all'utente prima |

## Procedura (in 5 secondi, senza scriverla)

1. **Classifica** il compito: meccanico → haiku; standard → sonnet; ragionamento critico o errore costoso → opus.
2. **Rischio**: se un errore avrebbe conseguenze serie (dati in produzione, soldi, contratti, sicurezza) sali di un livello.
3. **Parti basso, scala solo se serve**: se il risultato è insufficiente, rifai con il livello successivo (un gradino per volta, massimo un tentativo per livello).
4. **Compiti misti**: spezza. La lettura/ricerca va a haiku, la decisione resta al modello più capace.

## Regole di risparmio token

- **Non delegare** ciò che richiede ≤ 3 chiamate a strumenti: farlo direttamente costa meno di un subagent.
- **Delega a haiku** le attività che leggono molto (esplorare il repo, scansionare log, riassumere documenti lunghi): così il contesto principale resta piccolo.
- **Brief corti e precisi** ai subagent: obiettivo, file da guardare, cosa è già escluso, formato di risposta. Chiedi **solo la conclusione**, non i contenuti dei file.
- **Parallelizza** subagent indipendenti in un unico messaggio.
- Leggi solo le parti utili dei file (`Grep`, `offset`/`limit`), non file interi.
- Risposte all'utente concise; niente riepiloghi ripetuti di cose già dette.
- Non rifare lavoro già fatto né riaprire decisioni già prese.

## Esempi rapidi

- "Trova dove viene calcolato il totale fattura" → `Agent(model: "haiku", subagent_type: "Explore")`
- "Correggi questo errore nel form" → sonnet (o direttamente, se breve)
- "Riprogetta il sistema di sincronizzazione offline" → opus
- "Rivedi questo contratto di subappalto" → opus
- "Rinomina queste 20 variabili" → haiku

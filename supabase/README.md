# Backend Supabase — Jarvis 81100

Codice versionato delle Edge Function del bot Telegram (progetto `xqbhujcnjvwbwzpwjujf`).
**Nessun segreto sta nel codice**: si leggono tutti da *Supabase → Project Settings → Edge Functions → Secrets*.

| Funzione | Ruolo |
|---|---|
| `functions/jarvis-81100` | Bot unico: comandi (`/brief /timbra /pianifica /pagata /spesa /richiesta`, foto distinte, vocali) + agente Jarvis in linguaggio libero che **propone** le scritture e le esegue solo dopo il ✅ |
| `functions/coordinatore-serale` | Webhook Telegram: gestisce il rapporto delle 18:00 / diario di bordo e inoltra tutto il resto a Jarvis |

## Segreti richiesti

| Nome | Cosa contiene |
|---|---|
| `TELEGRAM_BOT_TOKEN` | token del bot (da BotFather) |
| `ANTHROPIC_API_KEY` | chiave API Anthropic (console.anthropic.com) |
| `OPENAI_API_KEY` | chiave OpenAI, solo per trascrivere i vocali (Whisper) |
| `BOT_PAROLA` | parola d'ordine per registrarsi al bot (`/start <parola>`) |
| `BOT_CRON_SECRET` | segreto lungo casuale per gli URL chiamati da pg_cron (`?cron=`, `?sera=`, `?setup=`) |
| `TELEGRAM_WEBHOOK_SECRET` | segreto lungo casuale (solo `A-Z a-z 0-9 _ -`) che Telegram manda in ogni chiamata |

Verifica (mostra solo quali sono impostati, mai i valori):
`https://xqbhujcnjvwbwzpwjujf.supabase.co/functions/v1/jarvis-81100?diag=1`

## Deploy

Le funzioni su Supabase contengono solo un `import` di questo file, fissato allo SHA del commit:

```ts
import "https://raw.githubusercontent.com/giaquintogiuseppe-bit/ottantunocento-mobile/<SHA>/supabase/functions/jarvis-81100/index.ts";
```

Per aggiornare: commit + push, poi ridistribuire la funzione con il nuovo SHA (`verify_jwt: false`: l'autenticazione è il secret del webhook Telegram).

## Attivazione (una volta)

1. Impostare i segreti qui sopra.
2. Aggiornare i cron (`cron.job`): `brief-81100` → `jarvis-81100?cron=<BOT_CRON_SECRET>`, `coordinatore-serale` → `?sera=<BOT_CRON_SECRET>`.
3. Ridistribuire `coordinatore-serale` e aprire `jarvis-81100?setup=<BOT_CRON_SECRET>` (imposta il webhook con il secret).

**Ritorno indietro**: aprire `assistente-81100?setup=<vecchio segreto>`: il webhook torna al bot precedente.

## Tabelle

- `jarvis_azioni` — proposte dell'agente (`proposta → eseguita / annullata / scaduta / errore`), valide 24 ore
- `jarvis_update_visti` — anti-doppione degli update Telegram (pulita ogni giorno dal brief)

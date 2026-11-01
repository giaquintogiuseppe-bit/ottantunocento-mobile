#!/usr/bin/env bash
# SessionStart: attiva la skill model-router con un promemoria minimo (~70 token).
cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Skill model-router attiva (.claude/skills/model-router/SKILL.md). Per ogni compito scegli il modello più economico che lo risolve bene: haiku = ricerca/lettura/estrazione/compiti meccanici; sonnet = coding e testi standard; opus = architettura, debug difficile, sicurezza, legale/fiscale; fable = solo se opus fallisce, previa conferma. Delega con Agent(model: ...), parti basso e scala di un gradino solo se serve. Carica la skill in caso di dubbio."}}
EOF

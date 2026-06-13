# KAZAP Backend IA Vocal — Guide de déploiement Render.com

> **Module M-01** · Backend Node.js pour la réception IA des appels Twilio  
> Déployé sur : `https://kazap-backend1.onrender.com`

---

## Prérequis

- Compte [Render.com](https://render.com) (plan gratuit suffisant pour démarrer)
- Compte Twilio avec un numéro de téléphone configuré
- Clé API Deepgram (compte sur [deepgram.com](https://deepgram.com))
- Clé API Anthropic (compte sur [console.anthropic.com](https://console.anthropic.com))
- Projet Firebase `kazap-f8ff6` avec Firestore activé
- Fichier de compte de service Firebase (JSON)

---

## Étape 1 — Préparer le dépôt GitHub

### Structure des fichiers à pousser

```
kazap-backend-ia-vocal/
├── server.js
├── deepgram.js
├── claude-agent.js
├── firestore-writer.js
├── package.json
└── .gitignore
```

### Contenu du `.gitignore`

```
node_modules/
.env
service-account.json
*.log
```

### Commandes Git

```bash
git init
git add .
git commit -m "feat: backend IA vocal KAZAP M-01"
git remote add origin https://github.com/TON_USERNAME/kazap-backend-ia-vocal.git
git push -u origin main
```

---

## Étape 2 — Créer le Web Service sur Render

1. Connecte-toi sur [dashboard.render.com](https://dashboard.render.com)
2. Clique sur **New → Web Service**
3. Connecte ton dépôt GitHub `kazap-backend-ia-vocal`
4. Configure le service :

| Champ | Valeur |
|---|---|
| **Name** | `kazap-backend1` |
| **Region** | `Frankfurt (EU Central)` — le plus proche de l'Afrique de l'Ouest |
| **Branch** | `main` |
| **Runtime** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `node server.js` |
| **Plan** | `Free` (ou Starter pour éviter le spin-down) |

5. Clique sur **Create Web Service**

---

## Étape 3 — Configurer les variables d'environnement

Dans Render → ton service → onglet **Environment**, ajoute ces variables :

### Variables Twilio

| Variable | Description | Exemple |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | Account SID Twilio global | `ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `TWILIO_AUTH_TOKEN` | Auth Token Twilio global | `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `TWILIO_FROM_NUMBER` | Numéro Twilio pour l'OTP SMS | `+22900000000` |
| `TWILIO_API_KEY` | API Key Twilio (pour les tokens VoIP) | `SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `TWILIO_API_SECRET` | API Secret Twilio | `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `TWILIO_APP_SID` | TwiML App SID (VoIP navigateur) | `APxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |

### Variables Deepgram

| Variable | Description |
|---|---|
| `DEEPGRAM_API_KEY` | Clé API Deepgram (Speech-to-Text) |

### Variables Anthropic (Claude)

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Clé API Anthropic (Claude) |

### Variables Firebase

| Variable | Description |
|---|---|
| `FIREBASE_PROJECT_ID` | `kazap-f8ff6` |
| `FIREBASE_SERVICE_ACCOUNT` | Contenu JSON du fichier service-account (voir ci-dessous) |

#### Comment obtenir `FIREBASE_SERVICE_ACCOUNT`

1. Firebase Console → Projet `kazap-f8ff6` → ⚙️ Paramètres → **Comptes de service**
2. Clique sur **Générer une nouvelle clé privée** → télécharge le JSON
3. Ouvre le fichier téléchargé, copie tout le contenu
4. Dans Render, colle le JSON complet comme valeur de `FIREBASE_SERVICE_ACCOUNT`

> ⚠️ Le JSON doit être sur **une seule ligne** (pas de retours à la ligne).  
> Commande pour le compresser sur une ligne :  
> ```bash
> cat service-account.json | tr -d '\n'
> ```

---

## Étape 4 — Configurer le webhook Twilio

### Pour la réception IA (numéro dédié IA de chaque vendeur)

Dans la [console Twilio](https://console.twilio.com) → **Phone Numbers** → sélectionne le numéro IA :

| Champ | Valeur |
|---|---|
| **A call comes in** | Webhook |
| **URL** | `https://kazap-backend1.onrender.com/call/incoming` |
| **HTTP Method** | `POST` |
| **Call Status Changes** | `https://kazap-backend1.onrender.com/call/status` |

> 💡 Répéter cette configuration pour chaque numéro Twilio attribué à un vendeur KAZAP.

---

## Étape 5 — Vérifier le déploiement

### Test du health check

```bash
curl https://kazap-backend1.onrender.com/
```

Réponse attendue :
```json
{
  "status": "ok",
  "service": "kazap-backend-ia-vocal",
  "version": "1.0.0"
}
```

### Logs en temps réel

Dans Render → ton service → onglet **Logs**

Lors du démarrage, tu dois voir :
```
🚀 KAZAP Backend IA Vocal démarré sur le port 3000
   Backend URL : https://kazap-backend1.onrender.com
   Endpoints IA Vocal :
     POST /call/incoming
     POST /call/status
     WS   /media-stream/:vendeurId
```

### Simulation d'un appel entrant

```bash
curl -X POST https://kazap-backend1.onrender.com/call/incoming \
  -d "CallSid=CAtest123&From=%2B22900000001&To=%2B22900000002&CallStatus=ringing"
```

Réponse attendue : XML TwiML avec le message d'accueil.

---

## Étape 6 — Configuration Firestore

Vérifie que la collection `ia_orders` existe (elle sera créée automatiquement au premier appel).

### Règles Firestore recommandées (en production)

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // ia_orders : lecture/écriture backend uniquement (via Admin SDK)
    match /ia_orders/{docId} {
      allow read, write: if false; // Accès uniquement via Firebase Admin
    }

    // vendors : lecture autorisée pour les vendeurs authentifiés
    match /vendors/{vendorId} {
      allow read: if request.auth != null && request.auth.uid == vendorId;
      allow write: if request.auth != null && request.auth.uid == vendorId;
    }
  }
}
```

---

## Résumé des endpoints

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/` | Health check |
| `POST` | `/sms/send` | Envoi SMS via Twilio |
| `POST` | `/otp/send` | Envoi OTP par SMS |
| `POST` | `/otp/verify` | Vérification OTP |
| `GET` | `/api/voip/token` | Token VoIP Twilio Client |
| `POST` | `/api/voip/incoming-call` | Appel entrant navigateur (TwiML) |
| `PATCH` | `/api/orders/:id/status` | Mise à jour statut commande |
| `POST` | `/api/save-fcm-token` | Enregistrement token FCM |
| `POST` | `/call/incoming` | **IA** Webhook Twilio appel entrant |
| `POST` | `/call/status` | **IA** Callback statut appel Twilio |
| `GET` | `/api/ia_orders` | **IA** Lecture des ia_orders |
| `POST` | `/api/voice/toggle` | **IA** Activation/désactivation réception IA |
| `WS` | `/media-stream/:vendeurId` | **IA** WebSocket Twilio → Deepgram → Claude |

---

## Dépannage

### Le serveur ne démarre pas

- Vérifier que `FIREBASE_SERVICE_ACCOUNT` est un JSON valide (utiliser [jsonlint.com](https://jsonlint.com))
- Vérifier que `ANTHROPIC_API_KEY` et `DEEPGRAM_API_KEY` sont bien renseignées

### L'appel entrant ne déclenche pas l'IA

- Vérifier que l'URL du webhook Twilio est exactement `https://kazap-backend1.onrender.com/call/incoming`
- Sur le plan gratuit Render, le serveur se met en veille après 15 minutes d'inactivité (spin-down). Le premier appel peut prendre 30-50 secondes. Passer au plan **Starter** ($7/mois) pour éviter cela.

### Deepgram ne transcrit pas

- Vérifier `DEEPGRAM_API_KEY` dans les variables d'environnement Render
- Vérifier dans les logs que `✅ Deepgram STT connecté` apparaît lors d'un appel

### Claude ne répond pas

- Vérifier `ANTHROPIC_API_KEY`
- Vérifier que le vendeur existe dans Firestore avec un `boutiqueName` et des `products`

---

*Document confidentiel · KAZAP · README-deploy.md · M-01_Backend_IA_Vocal*

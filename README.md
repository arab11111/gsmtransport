# GSM Transport de Bagages

Application web pour la gestion des réservations et bagages avec notifications temps réel entre France et Algérie.

## 🚀 Démarrage rapide

### Installation

```bash
npm install
```

### Lancement du serveur

```bash
npm start
```

Le serveur démarre sur http://localhost:3000

## 🧰 Passage à une version SaaS (Firebase)

Si vous voulez transformer ce projet en SaaS avec Firebase, suivez ces étapes :

1. Créez un projet Firebase via https://console.firebase.google.com
2. Activez Firestore, Authentication (Email/Password + Google) et Cloud Functions
3. Copiez votre configuration Firebase dans `public/firebase-config.js` (ex. fourni `public/firebase-config.example.js`)
4. Déployez les fonctions depuis le dossier `firebase/functions` ou `functions` selon votre setup
5. Ouvrez l'admin : `/public/admin/index.html` (page d'amorçage)

Je peux automatiquement :
- créer la structure Firestore (`users`, `reservations`, `settings`)
- ajouter l'authentification (email/password + Google)
- implémenter des Cloud Functions pour gérer les réservations et générer PDFs

Répondez "Ok, commence" et je commencerai par initialiser les fichiers de configuration et l'API serverless.

## 📱 Utilisation

1. Ouvrez http://localhost:3000 dans votre navigateur
2. Choisissez l'application souhaitée :
   - **GSM Express** : Gestion des réservations et expéditeurs
   - **Gestion Bagages** : Suivi et gestion des bagages

## 🔄 Notifications temps réel

- Quand une nouvelle réservation est créée dans GSM Express, elle est automatiquement convertie en entrée bagage dans Gestion Bagages
- Les notifications apparaissent en temps réel grâce à Socket.IO
- Pas besoin de rafraîchir la page

## 🛠️ Technologies utilisées

- **Frontend** : HTML5, CSS3, JavaScript
- **Backend** : Node.js, Express.js
- **Temps réel** : Socket.IO
- **Génération PDF** : jsPDF
- **Codes QR** : QRCode.js

## 📁 Structure du projet

```
d:\essay\
├── index.html          # Page d'accueil
├── gsmexpress.html     # Application GSM Express
├── bagages.html        # Application Gestion Bagages
├── server.js           # Serveur Node.js
├── package.json        # Dépendances
└── README.md          # Documentation
```

## 🔧 Fonctionnalités

### GSM Express
- Gestion des informations expéditeur
- Création de réservations
- Génération de PDF pour les réservations
- Codes QR pour les bagages
- Export/import des données

### Gestion Bagages
- Liste des bagages avec filtres
- Conversion automatique des réservations
- Statistiques et rapports PDF
- Notifications en temps réel
- Gestion des paiements

## 🌐 Accès réseau

Le serveur écoute sur toutes les interfaces. Pour accéder depuis d'autres appareils sur le réseau :

1. Trouvez l'adresse IP de votre machine
2. Accédez via `http://IP:3000`

## 📊 Données

Les données sont stockées localement dans le navigateur (localStorage) et synchronisées en temps réel via le serveur.
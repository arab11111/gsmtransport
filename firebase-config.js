// WARNING: Cette configuration contient des clés publiques de Firebase.
// Ne commitez pas ce fichier dans un dépôt public si vous n'êtes pas sûr.
// Si vous préférez, gardez seulement public/firebase-config.example.js et ajoutez
// la vraie config localement ou via des variables d'environnement.

window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyBEbxKnHt2QSrrWGTdI6Mgz7o8yca0g2ek",
  authDomain: "gsmtransport-d1def.firebaseapp.com",
  projectId: "gsmtransport-d1def",
  storageBucket: "gsmtransport-d1def.firebasestorage.app",
  messagingSenderId: "274060784483",
  appId: "1:274060784483:web:b5b963a46d6619c938d956",
  measurementId: "G-53ZPPNKRLB"
};

// Si vous chargez le SDK Firebase en global (v8), initialisez ainsi :
if (window.firebase && !window.firebase.apps?.length) {
  try {
    window.firebase.initializeApp(window.FIREBASE_CONFIG);
  } catch (e) {
    console.warn('Firebase init skipped:', e);
  }
}

// Si vous utilisez des modules/bundlers, importez et utilisez `firebaseConfig` depuis ce fichier.

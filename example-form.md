# Formulaire

## Projet

Nom du proejet :
La valse des sens

Déjà existant :
Oui - contraintes à respecter

Zip

Description / brief :
boutique de bougies artisanales pour pros et particuliers

## Fonctionnel

tout cocher

Fournisseur de paiement :
paypal

Stratégie e-mail :
smtp (nodemailer)

Règles métier spécifiques :
Pas de cumule entre les promotions : Si 2 promotions existent sur le même produit, Il faut afficher et prendre la plus avantageuse pour le client.

## Technique

Architecture :
Monolythe

Rendering :
SSR

Langages :
Typescript

Frameworks :
nuxt 3

Base de données :
mysql

ORM :
drizzle

Styling :
css modules

Testing :
vitest, playright

Runtime :
node

Conteneurisation :
docker

Versioning / contraintes versions :
node >= 22

## Sécurité

Session / JWT :
JWT (JSON Web Token) pour la gestion des sessions utilisateur.

## Références visuelles

Notes visuelles :

## Aperçu global du site e-commerce

Document de direction artistique et fonctionnelle pour le développement web

Maquettes d'intention - contenus, photos et produits à adapter avant mise en ligne

---

## 01 - Page d'accueil - maquette validée

Menu enrichi avec Cadeaux & expériences ; reste de la page conservé.

---

## 02 - Nos bougies - maquette validée

Menu enrichi avec Cadeaux & expériences ; reste de la page conservé.

---

## 03 - Cadeaux & expériences - nouvelle page

Nouvelle rubrique ajoutée dans la continuité de la direction validée.

---

## 04 - Fiche produit - maquette validée

Menu enrichi avec Cadeaux & expériences ; reste de la page conservé.

---

## 05 - Nos histoires - maquette validée

Menu enrichi avec Cadeaux & expériences ; reste de la page conservé.

---

## 06 - La Maison - maquette validée

Menu enrichi avec Cadeaux & expériences ; reste de la page conservé.

---

## 07 - Professionnels - maquette validée

Menu enrichi avec Cadeaux & expériences ; reste de la page conservé.

---

## 08 - Contact - maquette validée

Menu enrichi avec Cadeaux & expériences ; reste de la page conservé.

---

## Référence responsive validée

Cette première vue mobile fixe l'esthétique et les proportions à décliner sur toutes les pages.

---

## Menu mobile complet

Le nouvel onglet apparaît dans la navigation responsive ouverte.

---

## Cadeaux & expériences - responsive

Déclinaison mobile de la nouvelle rubrique.

---

# Responsive - Boutique et fiche produit

## NOS BOUGIES

Vidéo verticale en tête, filtres sur une ligne défilante, produits en deux colonnes, mêmes noms, prix et visuels que sur ordinateur.

## CADEAUX & EXPÉRIENCES

Vidéo verticale en tête, coffrets en deux colonnes, expériences éditoriales empilées et appels à l'action sobres.

## FICHE PRODUIT

Vidéo verticale en premier, puis titre, prix, notes olfactives et bouton d'achat. Vignettes en carrousel horizontal, accordéons empilés.

## RÈGLE

Ne changer ni les textes, ni les couleurs, ni les produits. Adapter uniquement largeur, ordre et taille des blocs.

---

# Responsive - Pages éditoriales et professionnelles

## NOS HISTOIRES

Vidéo verticale, lecteur audio pleine largeur, épisodes en carrousel ou sur deux colonnes, mêmes titres et durées.

## LA MAISON

Vidéo verticale, manifeste pleine largeur, séquence émotion-histoire-création empilée, mêmes textes et mêmes images.

## PROFESSIONNELS

Vidéo verticale, cibles en carrousel, offres empilées, étapes numérotées puis formulaire pleine largeur.

## CONTACT

Vidéo verticale, texte d'introduction, formulaire pleine largeur, bloc Professionnels et pied de page.

---

# Repères pour le développement responsive

## NAVIGATION

- Nos bougies
- Cadeaux & expériences
- Nos histoires
- La Maison
- Professionnels
- Contact
- Compte et panier

## FONCTIONS CLÉS

- Vidéo différente sur chaque page
- Vidéo spécifique sur chaque fiche produit
- Lecteur audio tactile
- Filtres horizontaux sur mobile
- Formulaires pleine largeur
- Menu mobile condensé

## PRINCIPES VISUELS

- Ivoire, brun, charbon, caramel, ambre
- Titres serif élégants
- Texte sans serif très lisible
- Grilles nettes inspirées du site de référence
- Aucun coeur ni décoration mignonne
- Priorité à l'expérience mobile

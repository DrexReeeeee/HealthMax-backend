# FitMax Backend API

Health-focused food scanner API with gamification, personalization, and offline sync capabilities.

## Overview

FitMax is a backend API that helps users make healthier food choices by:
- Scanning product barcodes to get nutritional information
- Calculating health scores based on nutrients and personal health goals
- Providing healthier alternatives in the same category
- Tracking scanning history with gamification elements
- Supporting offline scanning with data sync

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** Supabase (PostgreSQL)
- **Authentication:** Supabase Auth
- **External API:** Open Food Facts

## Project Structure

```
fitmax-backend/
├── src/
│   ├── config/           # Configuration files
│   │   ├── supabase.js  # Supabase client
│   │   └── README.md    # Config documentation
│   ├── controllers/     # Request handlers
│   │   ├── authController.js
│   │   ├── productController.js
│   │   ├── historyController.js
│   │   ├── gamificationController.js
│   │   ├── dashboardController.js
│   │   ├── profileController.js
│   │   ├── syncController.js
│   │   └── README.md    # Controllers documentation
│   ├── middleware/     # Express middleware
│   │   ├── authMiddleware.js
│   │   └── README.md    # Middleware documentation
│   ├── routes/         # Route definitions
│   │   ├── authRoutes.js
│   │   ├── productRoutes.js
│   │   ├── historyRoutes.js
│   │   ├── gamificationRoutes.js
│   │   ├── dashboardRoutes.js
│   │   ├── profileRoutes.js
│   │   ├── syncRoutes.js
│   │   └── README.md    # Routes documentation
│   ├── services/       # Business logic
│   │   ├── scoringService.js
│   │   ├── personalizationService.js
│   │   ├── gamificationService.js
│   │   ├── alternativeService.js
│   │   └── README.md    # Services documentation
│   ├── app.js          # Express app setup
│   └── server.js       # Server entry point
├── package.json
├── package-lock.json
└── .gitignore
```

## API Endpoints

| Method | Endpoint             | Description                    | Auth Required |
|--------|---------------------|-------------------------------|---------------|
| POST   | `/api/auth/register` | Register a new user           | No            |
| POST   | `/api/auth/login`   | Login user                    | No            |
| GET    | `/api/product/:barcode` | Get product by barcode   | Optional      |
| POST   | `/api/history`      | Save scan to history         | Yes           |
| GET    | `/api/history`      | Get scan history             | Yes           |
| GET    | `/api/gamification` | Get user's gamification     | Yes           |
| GET    | `/api/dashboard`    | Get user dashboard data     | Yes           |
| POST   | `/api/profile`     | Save user profile            | Yes           |
| GET    | `/api/profile`    | Get user profile             | Yes           |
| POST   | `/api/sync`        | Sync offline scan data       | Yes           |
| GET    | `/health`          | Health check                 | No            |

## Getting Started

### Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- Supabase account (for database)

### Installation

```bash
# Install dependencies
npm install
```

### Environment Setup

Create a `.env` file in the root directory:

```env
SUPABASE_URL=your_supabase_url
SUPABASE_KEY=your_supabase_anon_key
PORT=3000
```

### Running the Server

```bash
# Development
npm run dev

# Production
npm start
```

The server will start on `http://localhost:3000` (or the PORT specified in .env)

---

## How to Test in Postman

### Step 1: Register a User

- **Method:** POST
- **URL:** `http://localhost:3000/api/auth/register`
- **Headers:** `Content-Type: application/json`
- **Body:**
```json
{
  "email": "testuser@example.com",
  "password": "TestPassword123!",
  "age": 30,
  "weight": 75,
  "health_goal": "low-sugar",
  "dietary_preference": "vegetarian"
}
```

### Step 2: Login

- **Method:** POST
- **URL:** `http://localhost:3000/api/auth/login`
- **Headers:** `Content-Type: application/json`
- **Body:**
```json
{
  "email": "testuser@example.com",
  "password": "TestPassword123!"
}
```

Copy the `access_token` from the response for later requests.

### Step 3: Scan a Product

- **Method:** GET
- **URL:** `http://localhost:3000/api/product/5000159484695`
- **Headers:** `Authorization: Bearer <your_access_token>`

### Step 4: Save a Scan

- **Method:** POST
- **URL:** `http://localhost:3000/api/history`
- **Headers:** 
  - `Content-Type: application/json`
  - `Authorization: Bearer <your_access_token>`
- **Body:**
```json
{
  "barcode": "5000159484695",
  "score": 4
}
```

### Step 5: Get Dashboard

- **Method:** GET
- **URL:** `http://localhost:3000/api/dashboard`
- **Headers:** `Authorization: Bearer <your_access_token>`

---

## Detailed Documentation

For more detailed information about each component:

- [Routes Documentation](./src/routes/README.md) - API endpoints with sample requests
- [Controllers Documentation](./src/controllers/README.md) - Business logic explained
- [Services Documentation](./src/services/README.md) - Score calculation, personalization, gamification
- [Middleware Documentation](./src/middleware/README.md) - Authentication middleware
- [Config Documentation](./src/config/README.md) - Supabase setup and database schema

---

## Sample Barcodes for Testing

| Barcode         | Product Name        | Category     |
|----------------|-------------------|--------------|
| 5000159484695  | Cadbury Dairy Milk | Chocolate   |
| 4006381333931  | Haribo Goldbears   | Candy       |
| 7622210449283  | Oreo Cookies       | Snacks      |
| 8076809513753  | Barilla Pasta      | Pasta       |

---

## Health Score System

Products are scored from 1-5:

| Score | Color  | Meaning             |
|-------|-------|---------------------|
| 1-2   | Red   | Unhealthy           |
| 3     | Yellow| Moderate            |
| 4-5   | Green | Healthy             |

**Scoring Factors:**
- Sugar content (penalty for high)
- Salt content (penalty for high)
- Saturated fat (penalty for high)
- Fiber (bonus for high)

**Personalization:**
Scores are adjusted based on user's health goals (low-sugar, low-salt, heart-health, etc.)

---

## Gamification Features

- **Points:** Earn 10 points for healthy scans, 5 for moderate
- **Streaks:** Track consecutive scanning days
- **Badges:** 
  - 💯 Centurion (100+ points)
  - 🔥 7-Day Streak (7 days in a row)
  - 💚 Health Hero (80%+ healthy choices)

---

## Offline Sync

The API supports syncing offline scan data from mobile apps:
- Accepts local scan history
- Checks for duplicates
- Merges gamification stats

---

## License

MIT

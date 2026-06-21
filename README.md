# MCBC Softball Stat Tracker — standalone setup

This is the same app you've been using inside Claude, repackaged to run on its
own with a real database, so it's no longer tied to a Claude account or
artifact link.

## 1. Create a free database (Supabase)

1. Go to [supabase.com](https://supabase.com), sign up free, and create a new project.
2. Once it's ready, open the **SQL Editor** and run:

```sql
create table app_kv (
  key text primary key,
  value text not null,
  updated_at timestamptz default now()
);
```

That single table holds all of the app's data (teams, players, games, stats,
lineups, history, trash) — it's the same simple key/value shape the app
already used inside Claude, just stored in your own database now.

3. Go to **Project Settings → API**. Copy the **Project URL** and the
   **anon public** key. You'll need both in the next step.

## 2. Configure the app

1. Copy `.env.example` to a new file named `.env`.
2. Fill in the two values you just copied:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

## 3. Run it locally

You'll need [Node.js](https://nodejs.org) installed (any recent version).

```bash
npm install
npm run dev
```

Open the URL it prints (usually `http://localhost:5173`). The app should load
exactly as it did inside Claude — same teams, same Lineup Builder, same
everything — just talking to your own database now.

## 4. Put it online

```bash
npm run build
```

This creates a `dist` folder with the finished app. Two easy free options to
host it:

- **Netlify Drop**: go to [app.netlify.com/drop](https://app.netlify.com/drop)
  and drag the `dist` folder onto the page. You'll get a public URL in
  seconds. No account strictly required, though making one lets you update
  the same site later instead of getting a new URL each time.
- **Vercel**: create a free account at [vercel.com](https://vercel.com),
  install the Vercel CLI (`npm i -g vercel`), then run `vercel` from this
  project's folder and follow the prompts.

Either way, you get a real URL you can send to your co-coaches — no Claude
account needed on their end, no "publish" link that can be permanently
revoked, and you fully control the data.

## About access and privacy

This setup does **not** add logins or per-person permissions — anyone who has
your app's URL can open it and edit the data, same as the shared-link
behavior you had inside Claude. The difference is the data lives in a
database you own, not tied to anyone's Claude account.

A technical note for later, if you ever want real access control (separate
logins for each coach, view-only access for players, etc.): Supabase has
built-in authentication and "Row Level Security" policies that can restrict
who can read or write each row. That's a bigger step than this setup covers,
but it's the natural next move if you outgrow "anyone with the link."

## Updating the app later

If you come back to Claude and ask for more features, you can re-export the
updated `App.jsx` and drop it into `src/App.jsx` here, replacing the old one.
Nothing else in this project needs to change, since `storage.js` already
handles talking to your database.

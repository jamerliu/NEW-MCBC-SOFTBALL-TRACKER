# MCBC Softball Stat Tracker

A stat tracking and game management app built for the MCBC church softball team. It covers roster management, batting and defensive lineup building, live at-bat tracking, and printable game reports, all designed for use on an iPad during games.

## Features

### Roster Management
- Player skill tiers, positional ratings, and coach notes
- Per-player season stat totals

### Game Stat Tracking
- Plus/minus steppers for at-bats, hits by type, RBI, and manually scored runs
- Season totals update automatically as stats are logged

### Batting Lineup Builder
- Drag-to-reorder lineup interface
- Optimization algorithm that balances OBP for leadoff spots and power (SLG/RBI) toward the front half of the order
- Gender alternation rule: max 3 men in a row, max 2 women in a row, with a stats-based exception for elite women

### Defensive Lineup Builder
- Assigns all 10 field positions across 8 innings
- Enforces a 4-girls/6-guys constraint per inning
- Minimum 2-inning play requirement per player, with conflict detection
- Innings-played tracker so no one is over or under-played

### Live At-Bat Tracker
- Draggable baseball diamond for base-running
- Top/Bottom half-inning progression with automatic team tab switching
- Opponent team tracking with a manually entered batting order
- Score updates automatically when a runner is dragged to home
- Game log grouped by inning, with quick RBI adjustment and undo (removing a play reverses its effect on that player's totals)

### Printable Reports
- Batting lineup sheet
- Defensive lineup sheet (landscape)
- Game report with inning-by-inning breakdown, showing base-reached and OUT indicators for each at-bat

## Tech Stack

- **Frontend:** React + Vite
- **Icons:** lucide-react
- **Backend/Database:** Supabase (PostgreSQL)
- **Hosting:** Vercel

## Getting Started

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
2. Set up a Supabase project and add your environment variables (make sure they're scoped to Production if deploying on Vercel):
   ```
   VITE_SUPABASE_URL=your_supabase_url
   VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
   ```
3. Run the app locally:
   ```bash
   npm run dev
   ```
4. Build for production:
   ```bash
   npm run build
   ```

## Multi-Coach Use

Data is stored in a shared Supabase database, so multiple coaches can log in and edit rosters, lineups, and live game stats at the same time. Changes made by one coach are visible to the others.

## Notes and Limitations

- The inning-by-inning game report only includes plays logged through the Live At-Bat Tracker. If you use the season-total +/- steppers directly for quick corrections, those update player totals correctly but won't appear as an entry in the inning-by-inning report, since there's no inning context attached to a stepper tap.
- Optimized for touch use on iPad during games.

## License

Internal use for the MCBC softball team.

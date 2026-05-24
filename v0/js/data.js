"use strict";
/* =================================================================
   INVENTION STUDIO LAYOUT RISK SIMULATOR — vanilla JS
   -----------------------------------------------------------------
   Core ideas:
   - All zone positions/sizes are stored in NORMALIZED coordinates
     (0..100 percent of the stage). This decouples the simulator
     from the pixel size of the embedded Matterport image and lets
     the dashboard be responsive.
   - The stage uses the Matterport overhead screenshot as a locked
     background image. Draggable, semi-transparent overlays sit on
     top to represent tool/work zones.
   - Scoring is two-step:
       1) FEASIBILITY checks — produce flags (Critical/Warning/Notice)
       2) Weighted metric scoring — 7 metrics combined into 0..100,
          modulated by traffic mode and active-use mode, then
          penalized by flag counts.
   ================================================================= */

/* ------------------------------------------------------------------
   1. ZONE CATALOG
       - id, label, risk (0..5), fixed (boolean), category,
         beginnerFriendly flag, default w/h in % of stage.
   ------------------------------------------------------------------ */
// label = full name (used in flags, exports, conclusion).
const ZONE_DEFS = [
  // FIXED
  { id:"entrance",      label:"Entrance",             short:"Entrance",   risk:0, fixed:true,  cat:"fixed", w:7,   h:5.5 },
  { id:"mainDesk",      label:"Main Desk",            short:"Main Desk",  risk:1, fixed:true,  cat:"fixed", beginner:true, w:7.5, h:5.5 },
  { id:"exitN",         label:"Emergency Exit North", short:"Exit N",     risk:0, fixed:true,  cat:"exit",  w:6.5, h:4.5 },
  { id:"exitS",         label:"Emergency Exit South", short:"Exit S",     risk:0, fixed:true,  cat:"exit",  w:6.5, h:4.5 },

  // BEGINNER-FRIENDLY / LOW
  { id:"craftland",     label:"Craftland",            short:"Craftland",  risk:1, beginner:true,  w:9, h:7 },
  { id:"xr",            label:"XR",                   short:"XR",         risk:1, beginner:true,  w:7, h:6 },

  // ASSEMBLY / WORK TABLES (central)
  { id:"asm1",          label:"Assembly Tables 1",    short:"Assembly 1", risk:2, beginner:true,  w:11, h:6 },
  { id:"asm2",          label:"Assembly Tables 2",    short:"Assembly 2", risk:2, beginner:true,  w:11, h:6 },

  // MODERATE
  { id:"bike",          label:"Bike / Mechanical",    short:"Bike",       risk:2, w:9, h:6 },
  { id:"storage",       label:"Storage",              short:"Storage",    risk:2, w:9, h:7 },
  { id:"electronics",   label:"Electronics / Soldering",short:"Electronics",risk:3, w:9, h:6 },
  { id:"print3d",       label:"3D Printing",          short:"3D Print",   risk:3, w:10, h:6 },

  // HIGH RISK
  { id:"laser",         label:"Laser Cutting",        short:"Laser",      risk:4, w:9, h:6 },
  { id:"cnc",           label:"CNC",                  short:"CNC",        risk:4, w:9, h:7 },
  { id:"metal",         label:"Metal Room",           short:"Metal",      risk:4, w:10, h:7 },
  { id:"wood",          label:"Wood Room",            short:"Wood",       risk:4, w:10, h:7 },

  // VERY HIGH RISK
  { id:"welding",       label:"Welding",              short:"Welding",    risk:5, w:9, h:6 },
  { id:"waterjet",      label:"Waterjet",             short:"Waterjet",   risk:5, w:9, h:6 },

  // CIRCULATION
  { id:"corridor",      label:"Main Corridor",        short:"Main Corridor", risk:0, cat:"corridor", w:18, h:5 },
  { id:"connector",     label:"Connector Corridor",   short:"Connector",  risk:0, cat:"corridor", w:8,  h:14 },
  { id:"rightOpen",     label:"Right-Side Open Area", short:"Open Area",  risk:0, cat:"open",     w:18, h:14 },
];

const RISK_TAGS = { 0:"—", 1:"Low", 2:"Mod", 3:"Mod-Hi", 4:"High", 5:"V.High" };
/* ------------------------------------------------------------------
   2. LAYOUT PRESETS
       Each preset stores normalized x/y/w/h overrides per zone id.
       Coordinates are tuned to the embedded Matterport screenshot:
         - Left ~0..52%   = dense main shop
         - Middle ~52..62%= connector / circulation
         - Right ~62..96% = open right-side area + lower-right room
   ------------------------------------------------------------------ */
const PRESETS = {
  current: {
    // Approximate as-observed baseline. Intentionally mixed — some
    // zones are placed pragmatically rather than optimally so the
    // simulator surfaces realistic flags for mentors to discuss.
    name:"Current Layout",
    zones:{
      // Fixed anchors
      entrance:    {x: 1.5, y:62},
      mainDesk:    {x: 9.5, y:60},
      exitN:       {x:91.5, y: 2},
      exitS:       {x:91.5, y:81},

      // LEFT DENSE SHOP — assembly central; high-risk wraps perimeter
      // but Wood and Metal sit close to assembly (typical real issue)
      asm1:        {x:18, y:48},
      asm2:        {x:31, y:48},
      craftland:   {x:34, y:80},          // far from entrance -> Notice/Warning
      xr:          {x:44, y:80},
      bike:        {x: 7, y:80},
      storage:     {x: 4, y: 4},
      electronics: {x:30, y:64},
      print3d:     {x:18, y:30},
      laser:       {x:32, y:38, w:9, h:6},  // adjacent to Assembly 2 -> R4 near beginner Warning
      wood:        {x:14, y:38, w:9, h:6},  // adjacent to Assembly 1 -> R4 near beginner Warning
      metal:       {x: 4, y:14},
      welding:     {x:16, y: 4},
      waterjet:    {x:28, y: 4},
      cnc:         {x:42, y:18},

      // CIRCULATION + RIGHT
      corridor:    {x:14, y:94, w:36, h:4},
      connector:   {x:53, y:18, w:7,  h:62},
      rightOpen:   {x:64, y: 8, w:30, h:48},
    }
  },
  altA: {
    name:"Alternative A — High-risk perimeter cluster",
    zones:{
      entrance:    {x: 1.5, y:62},
      mainDesk:    {x: 9.5, y:60},
      exitN:       {x:91.5, y: 2},
      exitS:       {x:91.5, y:81},

      // Pull beginner zones forward to the entrance
      craftland:   {x:11, y:55},
      xr:          {x:24, y:74},
      asm1:        {x:24, y:46},
      asm2:        {x:36, y:46},
      bike:        {x:36, y:60},

      // Push heavy/high-risk to top + back perimeter of left shop
      welding:     {x: 4, y: 4},
      waterjet:    {x:14, y: 4},
      metal:       {x:24, y: 4},
      wood:        {x:36, y: 4},
      cnc:         {x: 4, y:18},
      laser:       {x:14, y:30},

      // Mid-risk between
      print3d:     {x:24, y:18},
      electronics: {x:36, y:18},
      storage:     {x: 4, y:78},

      corridor:    {x:14, y:94, w:36, h:4},
      connector:   {x:53, y:18, w:7,  h:62},
      rightOpen:   {x:64, y: 8, w:30, h:48},
    }
  },
  altB: {
    name:"Alternative B — Right-side specialized rooms",
    zones:{
      entrance:    {x: 1.5, y:62},
      mainDesk:    {x: 9.5, y:60},
      exitN:       {x:91.5, y: 2},
      exitS:       {x:91.5, y:81},

      // Beginner & assembly central-left
      craftland:   {x:11, y:60},
      xr:          {x:24, y:78},
      asm1:        {x:21, y:46},
      asm2:        {x:34, y:46},
      bike:        {x:13, y:80},
      electronics: {x:34, y:62},
      print3d:     {x:18, y:30},
      storage:     {x: 3, y:30},

      // Move high-risk specialized rooms to the right side
      welding:     {x:65, y:60},
      waterjet:    {x:75, y:60},
      metal:       {x:85, y:60},
      cnc:         {x:65, y:34},
      wood:        {x:78, y:34},
      laser:       {x:32, y:30},

      corridor:    {x:14, y:94, w:36, h:4},
      connector:   {x:54, y:14, w:7,  h:64},
      rightOpen:   {x:64, y: 4, w:30, h:30},
    }
  }
};
/* ------------------------------------------------------------------
   3. REGION SHADES — visual hints for the three big areas
   ------------------------------------------------------------------ */
const REGIONS = [
  { label:"Dense Main Shop",       x: 1, y: 1, w:51, h:97, color:"rgba(90,169,255,.04)" },
  { label:"Connector Corridor",    x:52, y: 1, w:11, h:97, color:"rgba(240,180,65,.05)" },
  { label:"Right-Side Open Area",  x:63, y: 1, w:35, h:97, color:"rgba(58,167,118,.04)" },
];
const METRIC_DEFS = [
  { id:"congestion",   label:"Congestion & Pathway Flow",            weight:0.20 },
  { id:"safety",       label:"Safety Behavior Risk",                 weight:0.20 },
  { id:"toolRisk",     label:"Tool Risk & Supervision",              weight:0.15 },
  { id:"access",       label:"Accessibility Quality",                weight:0.15 },
  { id:"workflow",     label:"Workflow Adjacency & Travel Efficiency",weight:0.15 },
  { id:"flex",         label:"Flexibility & Future Adaptability",    weight:0.10 },
  { id:"beginner",     label:"Beginner Approachability",             weight:0.05 },
];

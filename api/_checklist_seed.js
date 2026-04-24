/* Checklist items extracted from "Daily Checklist of Meena Bazaar Showrooms" (PDF).
   category: 'daily' (with timeline) | 'existence' (without timeline) | 'compliance' (non-negotiable)
   parent_id is filled at runtime for sub-items of the Floor Walk parent. */
const FLOOR_WALK_SUBS = [
  'Physical space cleaning',
  'All lights are in working condition',
  'ACs are in working condition',
  'Security Antenna (Sensormatic) is working',
  'Signage is working',
  'Genset is having sufficient fuel (Register to maintain)',
  'No Boxes on Floor',
  'Window display & hanging products are ironed',
  'Window Glass and Mirrors are cleaned and spotless',
  'No Dust on shelves / hanging area / Cobwebs',
  'Staff are in uniform, properly groomed, light makeup (female), Name tags',
  'Inspected registers: Fall / Alterations / Attendance / Diesel / AMC & others',
  'Airfreshners are working and no odour in showroom',
  'Sufficient carry bags / billing rolls / card rolls',
  'All products have security tags and barcode (random check all categories)',
  'CCTV working and has backup of 30 Days',
];

const items = [];
let order = 0;
const add = (o) => { items.push({ ...o, sort_order: ++order }); };

/* ── DAILY (with timeline) ───────────────────────────────────── */
add({ area_tag:'Physical Space', category:'daily', responsible:'Showroom Team', action_text:'Showroom opened on time by minimum 2 or more staff', timeline:'10:30' });
add({ area_tag:'Physical Space', category:'daily', responsible:'Showroom Team', action_text:'All staff punched in Bio-Metric attendance', timeline:'10:30' });
add({ area_tag:'Physical Space', category:'daily', responsible:'Showroom Team', action_text:'All staff also signed in attendance register', timeline:'10:30' });
add({ area_tag:'Physical Space', category:'daily', responsible:'Showroom Team', action_text:'Cleaning of Showroom, Showcase Glass, Mirrors, Signage Board', timeline:'10:30 to 10:45' });
add({ area_tag:'Physical Space', category:'daily', responsible:'Showroom Team', action_text:'Fixtures are placed correctly, aligned, straight, in working order', timeline:'10:30 to 10:45' });
add({ area_tag:'Physical Space', category:'daily', responsible:'Showroom Team', action_text:'Music playing at all times / Store Fragrance', timeline:'All Day' });

add({ area_tag:'People', category:'daily', responsible:'Showroom Team', action_text:'Staff grooming (Uniform, Tag, Name Badge, Makeup, Shave, Shoes etc.)', timeline:'10:30 to 10:45' });

add({ area_tag:'Leadership', category:'daily', responsible:'Showroom Team', action_text:'Update Store opening & attendance to respective HoS on WhatsApp group', timeline:'10:45' });

add({ area_tag:'Product', category:'daily', responsible:'Showroom Team', action_text:'Physical count of stock completed', timeline:'10:45 to 11:15' });
add({ area_tag:'Product', category:'daily', responsible:'Customer Service', action_text:'No New Stocks are in backroom (only repeat collections allowed)', timeline:'10:45 to 11:15' });

add({ area_tag:'Leadership', category:'daily', responsible:'Showroom Team', action_text:'All mobiles submitted on cash counter in silent mode (allowed to use in Tea Break)', timeline:'10:45' });
add({ area_tag:'Leadership', category:'daily', responsible:'Manager', action_text:"Manager's Morning call with respective HoS", timeline:'20-30 Mins' });
add({ area_tag:'Leadership', category:'daily', responsible:'Showroom Team', action_text:'Folding, stacking and hanging completed, all items in correct place', timeline:'10:45 to 11:15' });
add({ area_tag:'Leadership', category:'daily', responsible:'Showroom Team', action_text:'Morning Meeting conducted as described (start with Gayatri Mantra)', timeline:'11:30 to 11:45' });

add({ area_tag:'People', category:'daily', responsible:'Showroom Team', action_text:'Tea Break (manage one by one)', timeline:'15 Mins' });

/* Leadership parent + 16 sub-items (Floor walk) */
const FW_ORDER = ++order;
items.push({ area_tag:'Leadership', category:'daily', responsible:'Manager',
             action_text:'Manager has completed Floor Walk and inspected each mentioned area',
             timeline:'11:45 to 12:00', sort_order: FW_ORDER, _is_parent:true });
FLOOR_WALK_SUBS.forEach((txt) => {
  items.push({ area_tag:'Leadership', category:'daily', responsible:'Manager',
               action_text:txt, timeline:'', sort_order: ++order, _parent_text:'Manager has completed Floor Walk and inspected each mentioned area' });
});

add({ area_tag:'Leadership', category:'daily', responsible:'Manager', action_text:'Daily closing report are checked & signed', timeline:'12:00 to 12:15' });

add({ area_tag:'Customer', category:'daily', responsible:'Manager/Cashier', action_text:'Checked Customer Orders or Requirements status', timeline:'12:00 to 12:15' });
add({ area_tag:'Customer', category:'daily', responsible:'Manager/Cashier', action_text:'Checked Falls / Alterations products received as per timeline', timeline:'12:00 to 12:15' });

add({ area_tag:'Physical Space', category:'daily', responsible:'Showroom Team', action_text:'Window displays as per VM Guideline & picture shared on group', timeline:'12:00 to 12:30' });
add({ area_tag:'Physical Space', category:'daily', responsible:'Cashier', action_text:'Cash Deposit and updated in DTR', timeline:'11:30 to 12:30' });

add({ area_tag:'Leadership', category:'daily', responsible:'Manager/Cashier', action_text:'Checked emails re: Stock transfers, Accounts, HR and any important updates', timeline:'Thrice a Day' });
add({ area_tag:'Leadership', category:'daily', responsible:'Showroom Team', action_text:'Serving customers with extraordinary service, patience, and fulfilment', timeline:'All Day' });

add({ area_tag:'People', category:'daily', responsible:'Showroom Team', action_text:'Every customer greeted "Namaste, Welcome to Meena Bazaar" by staff at the entrance', timeline:'All Day' });

add({ area_tag:'Leadership', category:'daily', responsible:'Manager/Cashier', action_text:'Status of customer orders / requirements updated in HoS-created structure', timeline:'All Day' });
add({ area_tag:'Leadership', category:'daily', responsible:'Manager', action_text:'Evening touch-base call with respective HoS and take actions for today', timeline:'4:00 to 4:15' });
add({ area_tag:'Leadership', category:'daily', responsible:'Manager', action_text:'Late evening touch-base call with respective HoS and take actions for today', timeline:'6:30 to 6:45' });

add({ area_tag:'People', category:'daily', responsible:'Showroom Team', action_text:'Closing reports and DTR updated', timeline:'Min before closing' });
add({ area_tag:'Physical Space', category:'daily', responsible:'Manager/Cashier', action_text:'Update Key Handover Register and sign while closing showroom', timeline:'Closing Time' });

/* ── EXISTENCE (without timeline) ────────────────────────────── */
add({ area_tag:'Physical Space', category:'existence', responsible:'Manager/Cashier', action_text:'All catalogue books are in good condition' });
add({ area_tag:'Physical Space', category:'existence', responsible:'Cashier/Manager', action_text:'Cash counter is tidy' });
add({ area_tag:'Physical Space', category:'existence', responsible:'Manager', action_text:'Validity and use of Fire extinguishers' });
add({ area_tag:'Physical Space', category:'existence', responsible:'Manager', action_text:'Cleaning of AC filters' });
add({ area_tag:'Physical Space', category:'existence', responsible:'Manager', action_text:'Checking of AMC and last service of ACs, Gensets, Inverters (register to maintain)' });
add({ area_tag:'Physical Space', category:'existence', responsible:'Cashier/Manager', action_text:'Cash counter in view of camera' });
add({ area_tag:'Physical Space', category:'existence', responsible:'Manager/Cashier', action_text:'Computer / EDC / Punching / CCTV / Internet / Printer are working' });
add({ area_tag:'Physical Space', category:'existence', responsible:'Manager', action_text:'All mannequins and podiums are in good condition' });
add({ area_tag:'Physical Space', category:'existence', responsible:'Showroom Team', action_text:'Mannequin-displayed products changed periodically' });
add({ area_tag:'Physical Space', category:'existence', responsible:'Manager', action_text:'All in-store visuals updated with latest product shoot (Drive to update — Article No, Date, Sales till date)' });
add({ area_tag:'Physical Space', category:'existence', responsible:'Showroom Team', action_text:'Deep floor cleaning once a week (on market closing day)' });

add({ area_tag:'People', category:'existence', responsible:'Manager', action_text:'Contents of First Aid kit as per norms' });
add({ area_tag:'People', category:'existence', responsible:'Manager', action_text:'Review 40 Actions once a week with team' });

add({ area_tag:'Leadership', category:'existence', responsible:'Cashier/Manager', action_text:'All customer feedbacks / complaints reviewed by Manager and reported to HoS in writing' });
add({ area_tag:'Leadership', category:'existence', responsible:'Cashier/Manager', action_text:'Manual bills updated in system (reason mentioned behind the bill if any generated)' });
add({ area_tag:'Leadership', category:'existence', responsible:'Cashier/Manager', action_text:'Cash counter and petty cash amount tallied' });
add({ area_tag:'Leadership', category:'existence', responsible:'Cashier/Manager', action_text:'Store licenses / legal documents / attendance register updated' });
add({ area_tag:'Leadership', category:'existence', responsible:'Cashier/Manager', action_text:'All manual bills carry reasons & bill number' });
add({ area_tag:'Leadership', category:'existence', responsible:'Cashier/Manager', action_text:'All Phone / Electrical / Water bills filed and sent to HO on time' });

add({ area_tag:'Customer', category:'existence', responsible:'Cashier/Sales Ex', action_text:'Customer data collection (Name, Phone Number, DOB)' });
add({ area_tag:'Customer', category:'existence', responsible:'Showroom Team', action_text:'Customers thanked after purchase by Cashier / Sales person' });
add({ area_tag:'Customer', category:'existence', responsible:'Manager', action_text:'Staff well trained in Product Knowledge: a) Fabric b) Style c) Fit d) Design e) Wash Care f) Exchange policy' });
add({ area_tag:'Customer', category:'existence', responsible:'Manager', action_text:'Staff recommending complementary items — jewellery, Grace Factor, shawls, accessories' });
add({ area_tag:'Customer', category:'existence', responsible:'Showroom Team', action_text:'All damaged items checked and sent to warehouse with approval' });
add({ area_tag:'Customer', category:'existence', responsible:'Showroom Team', action_text:'Plastic covers on stock changed at regular intervals' });
add({ area_tag:'Customer', category:'existence', responsible:'Manager/Cashier', action_text:'Check customer complaints (if any)' });
add({ area_tag:'Customer', category:'existence', responsible:'Showroom Team', action_text:'Give visiting cards to customers' });
add({ area_tag:'Customer', category:'existence', responsible:'Manager', action_text:'Resolve customer complaints related to staff behaviour and report to HoS in writing' });
add({ area_tag:'Customer', category:'existence', responsible:'Showroom Team', action_text:'Check customer defective tickets status — follow up if not closed' });
add({ area_tag:'Customer', category:'existence', responsible:'Showroom Team', action_text:'Greeting customers with folded hands: "Namaste, Welcome to Meena Bazaar"' });
add({ area_tag:'Customer', category:'existence', responsible:'Showroom Team', action_text:'Ask open-ended questions to identify customer needs' });
add({ area_tag:'Customer', category:'existence', responsible:'Showroom Team', action_text:'Recommend alternative products and show all available categories' });
add({ area_tag:'Customer', category:'existence', responsible:'Showroom Team', action_text:'Offer visitor book while completing the transaction' });
add({ area_tag:'Customer', category:'existence', responsible:'Showroom Team', action_text:'Thank the customer and invite them to revisit' });
add({ area_tag:'Customer', category:'existence', responsible:'Showroom Team', action_text:'Inform customers about other branches available in their city' });

/* ── NON-NEGOTIABLE COMPLIANCE ──────────────────────────────── */
add({ area_tag:'Compliance', category:'compliance', responsible:'Manager', action_text:'No incident of misusing cash / cards' });
add({ area_tag:'Compliance', category:'compliance', responsible:'Manager', action_text:'No committees / chit funds running in store' });
add({ area_tag:'Compliance', category:'compliance', responsible:'Manager', action_text:'No incident of harassment / altercation / physical fight' });
add({ area_tag:'Compliance', category:'compliance', responsible:'Manager', action_text:'No misuse of official assets' });
add({ area_tag:'Compliance', category:'compliance', responsible:'Manager', action_text:'No compromise on staff grooming' });
add({ area_tag:'Compliance', category:'compliance', responsible:'Manager', action_text:'Daily cash counting and cash deposit' });
add({ area_tag:'Compliance', category:'compliance', responsible:'Manager', action_text:'Behaviour with customers is polite and welcoming' });

module.exports = items;

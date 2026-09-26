const TREASURE_LOCATIONS = [
    {
        country: "India",
        island: "Andaman Islands",
        flag: "🇮🇳",
        search: "Andaman Islands tropical beach",
    },
    {
        country: "Japan",
        island: "Okinawa Island",
        flag: "🇯🇵",
        search: "Okinawa Island tropical beach",
    },
    {
        country: "Indonesia",
        island: "Bali",
        flag: "🇮🇩",
        search: "Bali island tropical beach",
    },
    {
        country: "Philippines",
        island: "Palawan",
        flag: "🇵🇭",
        search: "Palawan island tropical beach",
    },
    {
        country: "Thailand",
        island: "Phuket",
        flag: "🇹🇭",
        search: "Phuket island tropical beach",
    },
    {
        country: "Maldives",
        island: "Maldives",
        flag: "🇲🇻",
        search: "Maldives island tropical beach",
    },
    {
        country: "Fiji",
        island: "Viti Levu",
        flag: "🇫🇯",
        search: "Fiji Viti Levu tropical beach",
    },
    {
        country: "Australia",
        island: "Tasmania",
        flag: "🇦🇺",
        search: "Tasmania island coast",
    },
    {
        country: "New Zealand",
        island: "North Island",
        flag: "🇳🇿",
        search: "New Zealand North Island coast",
    },
    {
        country: "Greece",
        island: "Crete",
        flag: "🇬🇷",
        search: "Crete Greece island beach",
    },
    {
        country: "Italy",
        island: "Sicily",
        flag: "🇮🇹",
        search: "Sicily Italy island coast",
    },
    {
        country: "Spain",
        island: "Mallorca",
        flag: "🇪🇸",
        search: "Mallorca island beach",
    },
    {
        country: "Portugal",
        island: "Madeira",
        flag: "🇵🇹",
        search: "Madeira island coast",
    },
    {
        country: "Brazil",
        island: "Ilhabela",
        flag: "🇧🇷",
        search: "Ilhabela Brazil island beach",
    },
    {
        country: "Canada",
        island: "Vancouver Island",
        flag: "🇨🇦",
        search: "Vancouver Island coast",
    },
    {
        country: "United Kingdom",
        island: "Isle of Wight",
        flag: "🇬🇧",
        search: "Isle of Wight coast",
    },

    // ─────────────────────────────
    // ASIA
    // ─────────────────────────────

    {
        country: "Malaysia",
        island: "Langkawi",
        flag: "🇲🇾",
        search: "Langkawi Malaysia tropical beach",
    },
    {
        country: "Singapore",
        island: "Sentosa Island",
        flag: "🇸🇬",
        search: "Sentosa Island Singapore coast",
    },
    {
        country: "Sri Lanka",
        island: "Sri Lanka",
        flag: "🇱🇰",
        search: "Sri Lanka tropical coast",
    },
    {
        country: "Taiwan",
        island: "Green Island",
        flag: "🇹🇼",
        search: "Green Island Taiwan coast",
    },
    {
        country: "South Korea",
        island: "Jeju Island",
        flag: "🇰🇷",
        search: "Jeju Island South Korea coast",
    },
    {
        country: "China",
        island: "Hainan Island",
        flag: "🇨🇳",
        search: "Hainan Island China tropical beach",
    },
    {
        country: "Myanmar",
        island: "Myeik Archipelago",
        flag: "🇲🇲",
        search: "Myeik Archipelago Myanmar islands",
    },
    {
        country: "Cambodia",
        island: "Koh Rong",
        flag: "🇰🇭",
        search: "Koh Rong Cambodia beach",
    },
    {
        country: "Timor-Leste",
        island: "Atauro Island",
        flag: "🇹🇱",
        search: "Atauro Island Timor Leste coast",
    },
    {
        country: "Russia",
        island: "Sakhalin Island",
        flag: "🇷🇺",
        search: "Sakhalin Island Russia coast",
    },

    // ─────────────────────────────
    // EUROPE
    // ─────────────────────────────

    {
        country: "France",
        island: "Corsica",
        flag: "🇫🇷",
        search: "Corsica France island coast",
    },
    {
        country: "Ireland",
        island: "Achill Island",
        flag: "🇮🇪",
        search: "Achill Island Ireland coast",
    },
    {
        country: "Iceland",
        island: "Iceland",
        flag: "🇮🇸",
        search: "Iceland dramatic coastline",
    },
    {
        country: "Malta",
        island: "Malta Island",
        flag: "🇲🇹",
        search: "Malta island Mediterranean coast",
    },
    {
        country: "Cyprus",
        island: "Cyprus",
        flag: "🇨🇾",
        search: "Cyprus Mediterranean coast",
    },
    {
        country: "Croatia",
        island: "Hvar",
        flag: "🇭🇷",
        search: "Hvar Croatia island coast",
    },
    {
        country: "Montenegro",
        island: "Sveti Nikola Island",
        flag: "🇲🇪",
        search: "Sveti Nikola Island Montenegro",
    },
    {
        country: "Norway",
        island: "Lofoten Islands",
        flag: "🇳🇴",
        search: "Lofoten Islands Norway coast",
    },
    {
        country: "Sweden",
        island: "Gotland",
        flag: "🇸🇪",
        search: "Gotland Sweden island coast",
    },
    {
        country: "Denmark",
        island: "Bornholm",
        flag: "🇩🇰",
        search: "Bornholm Denmark island coast",
    },
    {
        country: "Estonia",
        island: "Saaremaa",
        flag: "🇪🇪",
        search: "Saaremaa Estonia island coast",
    },

    // ─────────────────────────────
    // AFRICA
    // ─────────────────────────────

    {
        country: "Madagascar",
        island: "Madagascar",
        flag: "🇲🇬",
        search: "Madagascar tropical coastline",
    },
    {
        country: "Mauritius",
        island: "Mauritius",
        flag: "🇲🇺",
        search: "Mauritius tropical beach",
    },
    {
        country: "Seychelles",
        island: "Mahé",
        flag: "🇸🇨",
        search: "Mahe Seychelles tropical beach",
    },
    {
        country: "Comoros",
        island: "Grande Comore",
        flag: "🇰🇲",
        search: "Grande Comore island coast",
    },
    {
        country: "Cape Verde",
        island: "Sal Island",
        flag: "🇨🇻",
        search: "Sal Island Cape Verde beach",
    },
    {
        country: "Tanzania",
        island: "Zanzibar",
        flag: "🇹🇿",
        search: "Zanzibar Tanzania tropical beach",
    },
    {
        country: "Mozambique",
        island: "Bazaruto Island",
        flag: "🇲🇿",
        search: "Bazaruto Island Mozambique beach",
    },
    {
        country: "South Africa",
        island: "Robben Island",
        flag: "🇿🇦",
        search: "Robben Island South Africa coast",
    },

    // ─────────────────────────────
    // NORTH AMERICA
    // ─────────────────────────────

    {
        country: "United States",
        island: "Maui",
        flag: "🇺🇸",
        search: "Maui Hawaii tropical beach",
    },
    {
        country: "Mexico",
        island: "Cozumel",
        flag: "🇲🇽",
        search: "Cozumel Mexico island beach",
    },
    {
        country: "Cuba",
        island: "Isla de la Juventud",
        flag: "🇨🇺",
        search: "Isla de la Juventud Cuba coast",
    },
    {
        country: "Bahamas",
        island: "Grand Bahama",
        flag: "🇧🇸",
        search: "Grand Bahama island beach",
    },
    {
        country: "Jamaica",
        island: "Jamaica",
        flag: "🇯🇲",
        search: "Jamaica tropical coast",
    },
    {
        country: "Dominican Republic",
        island: "Saona Island",
        flag: "🇩🇴",
        search: "Saona Island Dominican Republic beach",
    },
    {
        country: "Haiti",
        island: "Île-à-Vache",
        flag: "🇭🇹",
        search: "Ile a Vache Haiti coast",
    },
    {
        country: "Costa Rica",
        island: "Isla Tortuga",
        flag: "🇨🇷",
        search: "Tortuga Island Costa Rica beach",
    },

    // ─────────────────────────────
    // SOUTH AMERICA
    // ─────────────────────────────

    {
        country: "Colombia",
        island: "San Andrés",
        flag: "🇨🇴",
        search: "San Andres Colombia island beach",
    },
    {
        country: "Ecuador",
        island: "Galápagos Islands",
        flag: "🇪🇨",
        search: "Galapagos Islands Ecuador coast",
    },
    {
        country: "Venezuela",
        island: "Margarita Island",
        flag: "🇻🇪",
        search: "Margarita Island Venezuela beach",
    },
    {
        country: "Chile",
        island: "Chiloé Island",
        flag: "🇨🇱",
        search: "Chiloe Island Chile coast",
    },
    {
        country: "Argentina",
        island: "Tierra del Fuego",
        flag: "🇦🇷",
        search: "Tierra del Fuego Argentina coast",
    },
    {
        country: "Uruguay",
        island: "Isla de Lobos",
        flag: "🇺🇾",
        search: "Isla de Lobos Uruguay coast",
    },

    // ─────────────────────────────
    // OCEANIA
    // ─────────────────────────────

    {
        country: "Papua New Guinea",
        island: "New Britain",
        flag: "🇵🇬",
        search: "New Britain Papua New Guinea coast",
    },
    {
        country: "Samoa",
        island: "Upolu",
        flag: "🇼🇸",
        search: "Upolu Samoa tropical beach",
    },
    {
        country: "Tonga",
        island: "Tongatapu",
        flag: "🇹🇴",
        search: "Tongatapu Tonga island coast",
    },
    {
        country: "Vanuatu",
        island: "Efate",
        flag: "🇻🇺",
        search: "Efate Vanuatu tropical beach",
    },
    {
        country: "Solomon Islands",
        island: "Guadalcanal",
        flag: "🇸🇧",
        search: "Guadalcanal Solomon Islands coast",
    },
    {
        country: "Palau",
        island: "Koror",
        flag: "🇵🇼",
        search: "Koror Palau tropical island",
    },
    {
        country: "Micronesia",
        island: "Pohnpei",
        flag: "🇫🇲",
        search: "Pohnpei Micronesia island coast",
    },
    {
        country: "Marshall Islands",
        island: "Majuro Atoll",
        flag: "🇲🇭",
        search: "Majuro Atoll Marshall Islands",
    },
    {
        country: "Kiribati",
        island: "Tarawa",
        flag: "🇰🇮",
        search: "Tarawa Kiribati island coast",
    },
    {
        country: "Tuvalu",
        island: "Funafuti",
        flag: "🇹🇻",
        search: "Funafuti Tuvalu island coast",
    },
];

module.exports = TREASURE_LOCATIONS;
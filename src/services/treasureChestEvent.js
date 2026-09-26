require("dotenv").config();
const TREASURE_LOCATIONS= require("../data/TREASURE_LOCATION_DATA")
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
} = require("discord.js");
const {
    createPaymentTransaction,
} = require("./paymentService");
const {
    hasTreasureCooldown,
    getTreasureCooldown,
    setTreasureCooldown,

    saveActiveTreasureChest,
    getActiveTreasureChest,
    deleteActiveTreasureChest,
    claimTreasureChest,
} = require("./treasureChestEventredis");

// ==========================================
// CONFIG
// ==========================================

const TREASURE_MIN = 25;
const TREASURE_MAX = 75;
const TREASURE_EXPIRY_MS =  10 * 1000; // 10 minutes
const PAYMENT_STAFF = [
    "1295671787375296542",
];


// ==========================================
// COUNTRY / ISLAND LOCATIONS
// ==========================================


// ==========================================
// RANDOM LOCATION
// ==========================================

function getRandomLocation() {
    return TREASURE_LOCATIONS[
        Math.floor(
            Math.random() * TREASURE_LOCATIONS.length
        )
    ];
}

// ==========================================
// RANDOM REWARD
// ==========================================

function getTreasureReward() {
    const tiers = [
        { weight: 50, min: 25, max: 35 },  // 50%
        { weight: 25, min: 36, max: 45 },  // 25%
        { weight: 13, min: 46, max: 55 },  // 13%
        { weight: 7, min: 56, max: 65 },  // 7%
        { weight: 3, min: 66, max: 75 },  // 3%
        { weight: 1.5, min: 76, max: 85 }, // 1.5%
        { weight: 0.5, min: 86, max: 100 }, // 0.5%
    ];
    const totalWeight = tiers.reduce(
        (sum, tier) => sum + tier.weight,
        0
    );

    let random = Math.random() * totalWeight;

    for (const tier of tiers) {
        random -= tier.weight;

        if (random <= 0) {
            return randomInteger(
                tier.min,
                tier.max
            );
        }
    }

    return TREASURE_MIN;
}

// ==========================================
// RANDOM INTEGER
// ==========================================

function randomInteger(min, max) {
    return Math.floor(
        Math.random() * (max - min + 1)
    ) + min;
}

// ==========================================
// PEXELS IMAGE
// ==========================================

async function getTreasureImage(searchQuery) {
    if (!process.env.PEXELS_API_KEY) {
        console.warn(
            "⚠️ PEXELS_API_KEY is missing."
        );

        return null;
    }

    try {
        const params = new URLSearchParams({
            query: searchQuery,
            orientation: "landscape",
            size: "medium",
            per_page: "10",
        });

        const response = await fetch(
            `https://api.pexels.com/v1/search?${params}`,
            {
                headers: {
                    Authorization:
                        process.env.PEXELS_API_KEY,
                },
            }
        );

        if (!response.ok) {
            throw new Error(
                `Pexels returned ${response.status}`
            );
        }

        const data = await response.json();

        if (!data.photos?.length) {
            return null;
        }

        const photo =
            data.photos[
            Math.floor(
                Math.random() *
                data.photos.length
            )
            ];

        return (
            photo.src?.landscape ||
            photo.src?.large ||
            photo.src?.medium ||
            null
        );
    } catch (error) {
        console.error(
            "❌ Pexels treasure image failed:",
            error.message
        );

        return null;
    }
}

// ==========================================
// COOLDOWN FORMAT
// ==========================================

function formatCooldown(seconds) {
    const days = Math.floor(
        seconds / 86400
    );

    const hours = Math.floor(
        (seconds % 86400) / 3600
    );

    const minutes = Math.floor(
        (seconds % 3600) / 60
    );

    const parts = [];

    if (days) {
        parts.push(`${days}d`);
    }

    if (hours) {
        parts.push(`${hours}h`);
    }

    if (minutes) {
        parts.push(`${minutes}m`);
    }

    return parts.join(" ") || "less than a minute";
}

// ==========================================
// OPEN BUTTON
// ==========================================

function buildTreasureButton(eventId) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(
                    `treasure_open_${eventId}`
                )
                .setLabel("🔓 Open Treasure Chest")
                .setStyle(ButtonStyle.Primary)
        ),
    ];
}

// ==========================================
// /TREASURE
// ==========================================

async function startTreasureChestEvent(interaction) {
    const userId = interaction.user.id;

    // ======================================
    // CREATE CHEST
    // ======================================

    const eventId = interaction.id;

    const location =
        getRandomLocation();

    const imageUrl =
        await getTreasureImage(
            location.search
        );

    const chest = {
        eventId,
        userId,
        location,
        imageUrl,
        opened: false,
        createdAt: Date.now(),
    };

    await saveActiveTreasureChest(chest);

    // ======================================
    // EMBED
    // ======================================

    const embed =
        new EmbedBuilder()
            .setColor(0xF1C40F)
            .setTitle(
                "🏝️ TREASURE CHEST WASHED ASHORE!"
            )
            .setDescription(
                `🌊 A powerful storm has washed a mysterious treasure chest ashore!\n\n` +
                `${location.flag} **${location.island}, ${location.country}**\n\n` +
                `📦 Something valuable may be hidden inside...\n\n` +
                `🔓 **Open the chest to discover your reward!**`
            )
            .setFooter({
                text:
                    "World Adventure Club • Treasure Hunt",
            });

    if (imageUrl) {
        embed.setImage(imageUrl);
    }

    // ======================================
    // SEND CHEST
    // ======================================
const response = await interaction.reply({
    embeds: [embed],
    components: buildTreasureButton(eventId),
    withResponse: true,
});

const messageId = response.resource.message.id;
const channelId = interaction.channelId;

setTimeout(async () => {
    try {
        const activeChest = await getActiveTreasureChest(eventId);

        // Someone already claimed it
        if (!activeChest || activeChest.opened) {
            return;
        }

        // Remove it from Redis
        await deleteActiveTreasureChest(eventId);

        const expiredEmbed = new EmbedBuilder()
            .setColor(0x7f8c8d)
            .setTitle("🏴‍☠️ TREASURE CHEST LOOTED BY THIEVES!")
            .setDescription(
                `⏰ **You were too late!**\n\n` +
                `🌊 The treasure chest at\n` +
                `${location.flag} **${location.island}, ${location.country}**\n\n` +
                `💨 The treasure hunters arrived too late...\n` +
                `The chest and its treasure are gone!`
            )
            .setFooter({
                text: "World Adventure Club • Treasure Hunt",
            });

        if (imageUrl) {
            expiredEmbed.setImage(imageUrl);
        }

        // Fetch channel directly
        const channel = await interaction.client.channels.fetch(channelId);

        // Fetch message directly
        const chestMessage = await channel.messages.fetch(messageId);

        await chestMessage.edit({
            embeds: [expiredEmbed],
            components: [],
        });

        console.log(
            `⏰ TREASURE EXPIRED | Event: ${eventId}`
        );

    } catch (error) {
        console.error(
            "❌ Failed to expire treasure chest:",
            error.message
        );
    }
}, TREASURE_EXPIRY_MS);

    console.log(
        `🏝️ TREASURE CHEST | ${location.island}, ${location.country}`
    );
}

// ==========================================
// OPEN TREASURE CHEST
// ==========================================

async function handleTreasureChestButton(interaction) {
    if (
        !interaction.customId.startsWith(
            "treasure_open_"
        )
    ) {
        return;
    }

    const eventId =
        interaction.customId.replace(
            "treasure_open_",
            ""
        );

    const chest =
        await getActiveTreasureChest(eventId);

    // ======================================
    // INVALID / EXPIRED CHEST
    // ======================================

    if (!chest) {
        await interaction.reply({
            content:
                "❌ This treasure chest is no longer available.",
            flags: MessageFlags.Ephemeral,
        });

        return;
    }

    const userId = interaction.user.id;

    // ======================================
    // ALREADY OPENED
    // ======================================

    if (chest.opened) {
        await interaction.reply({
            content:
                "📦 This treasure chest has already been opened!",
            flags: MessageFlags.Ephemeral,
        });

        return;
    }

    // ======================================
    // CHECK COOLDOWN AGAIN
    // ======================================

    try {
        if (await hasTreasureCooldown(userId)) {
            const ttl =
                await getTreasureCooldown(userId);


            console.log(
                `⏳ TREASURE COOLDOWN | User: ${interaction.user.username} | ` +
                `ID: ${userId} | ` +
                `Remaining: ${formatCooldown(ttl)}`
            );

            await interaction.reply({
                content:
                    `⏳ You already claimed a treasure!\n` +
                    `Come back in **${formatCooldown(ttl)}**.`,
                flags: MessageFlags.Ephemeral,
            });

            return;
        }
    } catch (error) {
        console.error(
            "❌ Treasure cooldown check failed:",
            error.message
        );

        await interaction.reply({
            content:
                "⚠️ I couldn't verify your treasure cooldown.",
            flags: MessageFlags.Ephemeral,
        });

        return;
    }
    // ======================================
    // ATOMIC CLAIM LOCK
    // ======================================

    const claimed = await claimTreasureChest(
        eventId,
        userId
    );

    if (!claimed) {
        await interaction.reply({
            content:
                "📦 Someone else opened this treasure chest first!",
            flags: MessageFlags.Ephemeral,
        });

        return;
    }
    // ======================================
    // LOCK CHEST
    // ======================================

    chest.opened = true;

    // ======================================
    // RANDOM REWARD
    // ======================================

    const reward =
        getTreasureReward();

    // ======================================
    // SAVE 3-DAY COOLDOWN
    // ======================================

    try {
        await setTreasureCooldown(userId);
    } catch (error) {
        chest.opened = false;

        console.error(
            "❌ Failed to save treasure cooldown:",
            error.message
        );

        await interaction.reply({
            content:
                "⚠️ I couldn't save your treasure claim. Please try again.",
            flags: MessageFlags.Ephemeral,
        });

        return;
    }

    // ======================================
    // RESULT EMBED
    // ======================================

    const resultEmbed =
        new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle(
                "🎉 TREASURE CHEST OPENED!"
            )
            .setDescription(
                `🌟 **Congratulations, <@${interaction.user.id}>!**\n\n` +
                `📦 You opened the treasure chest washed ashore at\n` +
                `${chest.location.flag} **${chest.location.island}, ${chest.location.country}**\n\n` +
                `💰 **You found ${reward} Mora inside!** 🪙`
            )
            .setFooter({
                text:
                    "World Adventure Club • Treasure Hunt",
            });

    if (chest.imageUrl) {
        resultEmbed.setImage(
            chest.imageUrl
        );
    }

    // ======================================
    // EDIT CHEST MESSAGE
    // ======================================

    await interaction.update({
        embeds: [resultEmbed],
        components: [],
    });

    // ======================================
    // PAYMENT STAFF NOTIFICATION
    // ======================================
    // ======================================
    // PAYMENT TRANSACTION
    // ======================================

    try {
        const winnerUser =
            await interaction.client.users.fetch(userId);

        await createPaymentTransaction({
            client: interaction.client,

            winnerId: userId,

            displayName:
                winnerUser.globalName ||
                winnerUser.username,

            username:
                winnerUser.username,

            eventName:
                `${chest.location.flag} ${chest.location.island}, ${chest.location.country}`,

            eventType:
                "Treasure Chest",

            reward,

            sourceChannelId:
                interaction.channelId,

            sourceMessageId:
                interaction.message?.id || null,
        });

    } catch (error) {
        console.error(
            "❌ Treasure payment transaction failed:",
            error.message
        );
    }

    console.log(
        `🎉 TREASURE OPENED | User: ${interaction.user.username} | ` +
        `Location: ${chest.location.island}, ${chest.location.country} | ` +
        `Reward: ${reward} Mora`
    );

    // ======================================
    // CLEAN MEMORY
    // ======================================

    await deleteActiveTreasureChest(eventId);
}

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
    startTreasureChestEvent,
    handleTreasureChestButton,
    getTreasureReward,
    getRandomLocation,
    getTreasureImage,
};
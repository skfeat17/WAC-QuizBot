const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
} = require("discord.js");

const {
    savePaymentTransaction,
    getPaymentTransaction,
    updatePaymentTransaction,
} = require("./paymentRedis");

// ==========================================
// PAYMENT STAFF
// ==========================================
const ID = process.env.CLIENT_ID;
"759810328791482428"  //kairi    
const PAYMENT_STAFF = (ID == 1551252240986149016) ? [
    "1242132608574292118", //me
] : ["1242132608574292118" //me
    , "759810328791482428"  //kairi
    , "1295671787375296542", //ani 
    "1161273612167295047", //zibai
    // "1316293140549730336" //skirk
]

// ==========================================

const MORA_EMOJI =
    "<:mora:1503931162525962333>";

function createTransactionId() {
    return (
        `TX-${Date.now().toString(36).toUpperCase()}-` +
        Math.random().toString(36).slice(2, 8).toUpperCase()
    );
}

function buildPaymentEmbed(transaction) {
    const status =
        transaction.status === "paid"
            ? "✅ Paid"
            : transaction.status === "processing"
                ? "🟡 Processing"
                : "❌ Unpaid";

    const embed = new EmbedBuilder()
        .setColor(
            transaction.status === "paid"
                ? 0x57F287
                : transaction.status === "processing"
                    ? 0xFEE75C
                    : 0xED4245
        )
        .setTitle(
            transaction.status === "paid"
                ? "💰 TRANSACTION COMPLETED"
                : "💰 PENDING TRANSACTION"
        )
        .addFields(
            {
                name: "Winner",
                value: `<@${transaction.winnerId}>`,
                inline: true,
            },
            {
                name: "Winner Username",
                value: `${transaction.username}`,
                inline: true,
            },
            {
                name: "Event",
                value: transaction.eventName,
                inline: false,
            },
            {
                name: "Event Type",
                value: transaction.eventType,
                inline: true,
            },
            {
                name: "Reward",
                value: `**${transaction.reward} Mora**`,
                inline: true,
            },
            {
                name: "Payment Status",
                value: status,
                inline: true,
            },
            {
                name: "Payment Command",
                value:
                    `/club payout club:World Adventure Club user:@${transaction.username} amount:${transaction.reward}`,
                inline: false,
            }
        )
        .setFooter({
            text: `Transaction ${transaction.transactionId}`,
        })
        .setTimestamp(transaction.createdAt);
    if (transaction.paidBy && transaction.paidAt) {
        embed.addFields({
            name: "Paid By",
            value: `<@${transaction.paidBy}> at <t:${Math.floor(transaction.paidAt / 1000)}:f>`,
            inline: false,
        });
    }
    return embed;
}

function buildPaymentButtons(transaction) {
    const paid = transaction.status === "paid";

    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel("Pay User")
                .setEmoji("💸")
                .setStyle(ButtonStyle.Link)
                .setURL(
                    "https://discordapp.com/channels/1116542113274929233/1538813984600227850"
                ),

            new ButtonBuilder()
                .setCustomId(
                    `payment_paid_${transaction.transactionId}`
                )
                .setLabel("Mark Paid")
                .setEmoji("✅")
                .setStyle(ButtonStyle.Success)
                .setDisabled(paid)
        ),
    ];
}

async function createPaymentTransaction({
    client,
    winnerId,
    displayName,
    username,
    eventName,
    eventType,
    reward,
    sourceChannelId = null,
    sourceMessageId = null,
}) {
    if (!client) {
        throw new Error("Payment service requires the Discord client.");
    }

    const transaction = {
        transactionId: createTransactionId(),
        winnerId,
        displayName: displayName || username || "Unknown User",
        username: username || "Unknown",
        eventName: eventName || "Unknown Event",
        eventType: eventType || "Unknown",
        reward: Number(reward) || 0,
        status: "unpaid",
        paidBy: null,
        sourceChannelId,
        sourceMessageId,
        staffMessages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };

    await savePaymentTransaction(transaction);

    for (const staffId of PAYMENT_STAFF) {
        try {
            const staff = await client.users.fetch(staffId);

            const message = await staff.send({
                embeds: [buildPaymentEmbed(transaction)],
                components: buildPaymentButtons(transaction),
            });

            transaction.staffMessages.push({
                staffId,
                channelId: message.channelId,
                messageId: message.id,
            });
        } catch (error) {
            console.error(
                `❌ Payment DM failed for staff ${staffId}:`,
                error?.message || error
            );
        }
    }

    await savePaymentTransaction(transaction);

    console.log(
        `💳 PAYMENT CREATED | ${transaction.transactionId} | ` +
        `Winner: ${username} | Reward: ${reward} Mora`
    );

    return transaction;
}

async function updateAllPaymentMessages(client, transaction) {
    await Promise.allSettled(
        (transaction.staffMessages || []).map(async (staffMessage) => {
            const channel = await client.channels.fetch(
                staffMessage.channelId
            );

            if (!channel) return;

            const message = await channel.messages.fetch(
                staffMessage.messageId
            );

            await message.edit({
                embeds: [buildPaymentEmbed(transaction)],
                components: buildPaymentButtons(transaction),
            });
        })
    );
}

async function handlePaymentButton(interaction) {
    if (!interaction.customId.startsWith("payment_paid_")) return;

    if (!PAYMENT_STAFF.includes(interaction.user.id)) {
        return interaction.reply({
            content: "❌ You are not authorized to mark payments as paid.",
            ephemeral: true,
        });
    }

    const transactionId = interaction.customId.replace("payment_paid_", "");

    try {
        const transaction = await getPaymentTransaction(transactionId);

        if (!transaction) {
            return interaction.reply({
                content: "❌ Transaction not found.",
                ephemeral: true,
            });
        }

        if (transaction.status === "paid") {
            return interaction.reply({
                content: "✅ This transaction has already been marked as paid.",
                ephemeral: true,
            });
        }

        const paidAt = Date.now();

        const updatedTransaction = {
            ...transaction,
            status: "paid",
            paidBy: interaction.user.id,
            paidAt,
        };

        // 1. UPDATE THE CLICKED EMBED IMMEDIATELY
        await interaction.update({
            embeds: [buildPaymentEmbed(updatedTransaction)],
            components: buildPaymentButtons(updatedTransaction),
        });

        // 2. DO EVERYTHING ELSE IN THE BACKGROUND
        setImmediate(async () => {
            try {
                await updatePaymentTransaction(transactionId, {
                    status: "paid",
                    paidBy: interaction.user.id,
                    paidAt,
                });

                await updateAllPaymentMessages(
                    interaction.client,
                    updatedTransaction,
                    interaction.message.id
                );

                console.log(
                    `✅ PAYMENT MARKED PAID | ${transactionId} `
                );
            } catch (error) {
                console.error("[PAYMENT] Background update failed:", error);
            }
        });

    } catch (error) {
        console.error("[PAYMENT] Button error:", error);

        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: "❌ Something went wrong while updating this payment.",
                ephemeral: true,
            }).catch(() => { });
        }
    }
}

module.exports = {
    PAYMENT_STAFF,
    createPaymentTransaction,
    handlePaymentButton,
    buildPaymentEmbed,
    buildPaymentButtons,
};

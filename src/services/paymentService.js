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

const PAYMENT_STAFF = [
    "1295671787375296542",
    "1242132608574292118",
];

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
            }
        )
        .setFooter({
            text: `Transaction ${transaction.transactionId}`,
        })
        .setTimestamp(transaction.createdAt);

    if (transaction.paidBy) {
        embed.addFields({
            name: "Paid By",
            value: `<@${transaction.paidBy}>`,
            inline: true,
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
    for (const staffMessage of transaction.staffMessages || []) {
        try {
            const channel = await client.channels.fetch(
                staffMessage.channelId
            );

            const message = await channel.messages.fetch(
                staffMessage.messageId
            );

            await message.edit({
                embeds: [buildPaymentEmbed(transaction)],
                components: buildPaymentButtons(transaction),
            });
        } catch (error) {
            console.error(
                `❌ Failed to update payment DM for ${staffMessage.staffId}:`,
                error?.message || error
            );
        }
    }
}

async function handlePaymentButton(interaction) {
    const customId = interaction.customId;

    if (!customId.startsWith("payment_paid_")) {
        return false;
    }

    if (!PAYMENT_STAFF.includes(interaction.user.id)) {
        await interaction.reply({
            content: "❌ You are not authorized to manage payments.",
            flags: MessageFlags.Ephemeral,
        });
        return true;
    }

    const transactionId =
        customId.slice("payment_paid_".length);

    const transaction =
        await getPaymentTransaction(transactionId);

    if (!transaction) {
        await interaction.reply({
            content: "❌ This payment transaction no longer exists.",
            flags: MessageFlags.Ephemeral,
        });
        return true;
    }

    if (transaction.status === "paid") {
        await interaction.reply({
            content: "ℹ️ This transaction has already been marked as paid.",
            flags: MessageFlags.Ephemeral,
        });
        return true;
    }

    const updated = await updatePaymentTransaction(
        transactionId,
        {
            status: "paid",
            paidBy: interaction.user.id,
            paidAt: Date.now(),
        }
    );

    await updateAllPaymentMessages(
        interaction.client,
        updated
    );

    await interaction.reply({
        content:
            `✅ Transaction **${transactionId}** marked as paid.\n` +
            `Winner: <@${updated.winnerId}>\n` +
            `Reward: **${updated.reward}** ${MORA_EMOJI}`,
        flags: MessageFlags.Ephemeral,
    });

    console.log(
        `✅ PAYMENT MARKED PAID | ${transactionId} | ` +
        `Winner: ${updated.winnerId} | Paid By: ${interaction.user.id}`
    );

    return true;
}

module.exports = {
    PAYMENT_STAFF,
    createPaymentTransaction,
    handlePaymentButton,
    buildPaymentEmbed,
    buildPaymentButtons,
};

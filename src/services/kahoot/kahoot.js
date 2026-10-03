const {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags,
} = require("discord.js");

const {
    createKahoot,
    listKahoots,
    getKahoot,
    saveKahoot,
    deleteKahoot,
    getQuestions,
} = require("./kahootRedis");

const {
    createQuestion,
    modifyQuestion,
    deleteQuestion: removeQuestion,
} = require("./kahootQuestions");

const {
    startKahoot,
    finishKahoot,
    submitAnswer,
} = require("./kahootGame");

const { buildLeaderboardText } = require("./kahootLeaderboard");
const questionDrafts = new Map();
const STAFF_IDS = new Set(
    String(process.env.KAHOOT_STAFF_USER_IDS || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
);

const ACTIONS = [
    ["create", "➕ Create Kahoot"],
    ["addquestion", "📝 Add Question"],
    ["modifyquestion", "✏️ Modify Question"],
    ["deletequestion", "🗑️ Delete Question"],
    ["viewquestions", "📋 View Questions"],
    ["settings", "⚙️ Settings"],
    ["rewards", "💰 Rewards"],
    ["start", "▶️ Start"],
    ["terminate", "🛑 Terminate"],
    ["leaderboard", "🏆 Leaderboard"],
    ["end", "⏹️ End"],
    ["deletekahoot", "🗑️ Delete Kahoot"],
];

function isStaff(userId) {
    return STAFF_IDS.has(userId);
}

async function unauthorized(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply({
        content: "❌ You are not authorized to manage Kahoot.",
    });
}

function actionMenu() {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId("kahoot:action")
            .setPlaceholder("Select a Kahoot action...")
            .addOptions(
                ACTIONS.map(([value, label]) => ({
                    label,
                    value,
                }))
            )
    );
}

function kahootSelect(action, kahoots) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`kahoot:select:${action}`)
            .setPlaceholder("Select a Kahoot...")
            .addOptions(
                kahoots.slice(0, 25).map((k) => ({
                    label: k.name.slice(0, 100),
                    description: `${k.status} • ${k.questionCount || 0} questions`,
                    value: k.id,
                }))
            )
    );
}

function createModal() {
    return new ModalBuilder()
        .setCustomId("kahoot:modal:create")
        .setTitle("Create Kahoot")
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("name")
                    .setLabel("Kahoot Name")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(100)
            )
        );
}

function questionModal(customId, title, existing = {}) {
    return new ModalBuilder()
        .setCustomId(customId)
        .setTitle(title)
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("question")
                    .setLabel("Question")
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setValue(existing.question || "")
                    .setMaxLength(1000)
            ),

            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("answer1")
                    .setLabel("Answer 1")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setValue(existing.answer1 || "")
                    .setMaxLength(200)
            ),

            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("answer2")
                    .setLabel("Answer 2")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setValue(existing.answer2 || "")
                    .setMaxLength(200)
            ),

            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("answer3")
                    .setLabel("Answer 3")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setValue(existing.answer3 || "")
                    .setMaxLength(200)
            ),

            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("answer4")
                    .setLabel("Answer 4")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setValue(existing.answer4 || "")
                    .setMaxLength(200)
            )
        );
}
function questionDetailsModal(customId, existing = {}) {
    return new ModalBuilder()
        .setCustomId(customId)
        .setTitle("Question Details")
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("correct")
                    .setLabel("Correct Answer: 1, 2, 3, or 4")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setValue(
                        existing.correctIndex !== undefined
                            ? String(Number(existing.correctIndex) + 1)
                            : ""
                    )
                    .setMaxLength(1)
            ),

            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("imageUrl")
                    .setLabel("Image URL (optional)")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false)
                    .setValue(existing.imageUrl || "")
                    .setMaxLength(1000)
            )
        );
}

function settingsModal(kahoot) {
    const settings = kahoot.settings || {};
    const questionTimer = Number.isInteger(Number(settings.questionTimer)) && Number(settings.questionTimer) > 0 ? Number(settings.questionTimer) : 15;
    const leaderboardTimer = Number.isInteger(Number(settings.leaderboardTimer)) && Number(settings.leaderboardTimer) > 0 ? Number(settings.leaderboardTimer) : 15;

    return new ModalBuilder()
        .setCustomId(`kahoot:modal:settings:${kahoot.id}`)
        .setTitle("Kahoot Settings")
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("questionTimer")
                    .setLabel("Question Timer (seconds)")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setValue(String(questionTimer))
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("leaderboardTimer")
                    .setLabel("Leaderboard Timer (seconds)")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setValue(String(leaderboardTimer))
            )
        );
}

function rewardsModal(kahoot) {
    const rewards = kahoot.rewards || {};

    return new ModalBuilder()
        .setCustomId(`kahoot:modal:rewards:${kahoot.id}`)
        .setTitle("Kahoot Rewards (1/2)")
        .addComponents(
            ["first", "second", "third", "fourth", "fifth"].map(
                (id) =>
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId(id)
                            .setLabel(`${id} Place Mora`)
                            .setStyle(TextInputStyle.Short)
                            .setRequired(true)
                            .setValue(String(rewards[id] || 0))
                    )
            )
        );
}

function participationRewardsModal(kahoot) {
    const rewards = kahoot.rewards || {};

    return new ModalBuilder()
        .setCustomId(`kahoot:modal:participation:${kahoot.id}`)
        .setTitle("Kahoot Rewards (2/2)")
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId("participation")
                    .setLabel("Participation Mora")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setValue(String(rewards.participation || 0))
            )
        );
}

async function handleKahootCommand(interaction) {
    if (!isStaff(interaction.user.id)) {
        return unauthorized(interaction);
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    await interaction.editReply({
        content: "🎮 **WAC Kahoot Manager**\nSelect an action below.",
        components: [actionMenu()],
    });
}

async function handleKahootActionSelect(interaction) {
    if (!isStaff(interaction.user.id)) {
        return unauthorized(interaction);
    }

    const action = interaction.values[0];

    if (action === "create") {
        await interaction.showModal(createModal());
        return;
    }

    const kahoots = await listKahoots();

    if (!kahoots.length) {
        await interaction.update({
            content: "❌ No Kahoots exist yet. Use **Create Kahoot** first.",
            components: [actionMenu()],
        });
        return;
    }

    await interaction.update({
        content: `🎮 **${action}**\nSelect the Kahoot to manage.`,
        components: [kahootSelect(action, kahoots)],
    });
}

async function handleKahootSelect(interaction) {
    if (!isStaff(interaction.user.id)) {
        return unauthorized(interaction);
    }

    const [, , action] = interaction.customId.split(":");
    const kahootId = interaction.values[0];
    const kahoot = await getKahoot(kahootId);

    if (!kahoot) {
        await interaction.update({
            content: "❌ Kahoot not found.",
            components: [actionMenu()],
        });
        return;
    }


    if (
        ["addquestion", "modifyquestion", "deletequestion", "settings", "rewards"].includes(
            action
        )
    ) {
        if (action === "addquestion") {
            await interaction.showModal(
                questionModal(
                    `kahoot:modal:q1:addquestion:${kahoot.id}:new`,
                    "Add Question"
                )
            );
            return;
        }

        if (action === "modifyquestion") {
            const questions = await getQuestions(kahoot.id);

            if (!questions.length) {
                await interaction.update({
                    content: "❌ This Kahoot has no questions.",
                    components: [actionMenu()],
                });
                return;
            }

            await interaction.update({
                content: "Select the question to modify.",
                components: [
                    new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId(`kahoot:modifyselect:${kahoot.id}`)
                            .setPlaceholder("Select question...")
                            .addOptions(
                                questions.slice(0, 25).map((q) => ({
                                    label: `Q${q.id}: ${q.question}`.slice(0, 100),
                                    value: String(q.id),
                                }))
                            )
                    ),
                ],
            });
            return;
        }

        if (action === "deletequestion") {
            const questions = await getQuestions(kahoot.id);

            if (!questions.length) {
                await interaction.update({
                    content: "❌ This Kahoot has no questions.",
                    components: [actionMenu()],
                });
                return;
            }

            await interaction.update({
                content: "Select the question to delete.",
                components: [
                    new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId(`kahoot:deleteselect:${kahoot.id}`)
                            .setPlaceholder("Select question...")
                            .addOptions(
                                questions.slice(0, 25).map((q) => ({
                                    label: `Q${q.id}: ${q.question}`.slice(0, 100),
                                    value: String(q.id),
                                }))
                            )
                    ),
                ],
            });
            return;
        }

        if (action === "settings") {
            await interaction.showModal(settingsModal(kahoot));
            return;
        }

        if (action === "rewards") {
            await interaction.showModal(rewardsModal(kahoot));
            return;
        }
    }

    if (action === "viewquestions") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const questions = await getQuestions(kahoot.id);

            if (!questions.length) {
                await interaction.editReply({
                    content: `📋 **${kahoot.name}** has no questions yet.`,
                });
                return;
            }

            const lines = questions.slice(0, 25).map((q, index) => {
                const answers = (q.options || [])
                    .map((answer, i) => `${i + 1}. ${answer}`)
                    .join("\n");

                return (
                    `**Q${index + 1} — ID ${q.id}**\n` +
                    `${q.question}\n` +
                    `${answers}\n` +
                    `✅ Correct: **${Number(q.correctIndex) + 1}**` +
                    (q.imageUrl ? `\n🖼️ ${q.imageUrl}` : "")
                );
            });

            const extra =
                questions.length > 25
                    ? `\n\n⚠️ Showing the first 25 of ${questions.length} questions.`
                    : "";

            await interaction.editReply({
                content:
                    `📋 **Questions — ${kahoot.name}**\n\n` +
                    lines.join("\n\n") +
                    extra,
            });
        } catch (error) {
            console.error("❌ Failed to view Kahoot questions:", error);

            await interaction.editReply({
                content:
                    `❌ Failed to load questions: ` +
                    `${error.message || "Unknown error."}`,
            });
        }

        return;
    }

    if (["start", "terminate", "leaderboard", "end", "deletekahoot"].includes(action)) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (action === "deletekahoot") {
            if (kahoot.status === "running") {
                await interaction.editReply({
                    content: "❌ You cannot delete a running Kahoot. Terminate it first.",
                });
                return;
            }

            await deleteKahoot(kahoot.id);
            await interaction.editReply({
                content: `🗑️ Deleted **${kahoot.name}** and its question pool.`,
            });
            return;
        }

        if (action === "start") {
            const result = await startKahoot(
                interaction.client,
                kahoot.id,
                interaction
            );

            if (!result.success) {
                const messages = {
                    not_found: "❌ Kahoot not found.",
                    invalid_state: "❌ Kahoot must be in the Created state.",
                    no_questions: "❌ Add at least one question first.",
                    another_active: "❌ Another Kahoot is already running.",
                };

                await interaction.editReply({
                    content: messages[result.reason] || "❌ Failed to start Kahoot.",
                });
                return;
            }

            await interaction.editReply({
                content: `🎮 **${kahoot.name}** has successfully started.`,
            });
            return;
        }

        if (action === "terminate" || action === "end") {
            if (kahoot.status !== "running") {
                await interaction.editReply({
                    content:
                        action === "terminate"
                            ? "❌ Only a running Kahoot can be terminated."
                            : "❌ Only a running Kahoot can be ended.",
                });
                return;
            }

            const result = await finishKahoot(
                interaction.client,
                kahoot.id,
                action === "terminate" ? "terminated" : "ended"
            );

            if (!result.success) {
                await interaction.editReply({
                    content: "❌ This Kahoot is not currently running.",
                });
                return;
            }

            await interaction.editReply({
                content:
                    action === "terminate"
                        ? `🛑 **${kahoot.name}** terminated.`
                        : `🏁 **${kahoot.name}** ended.`,
            });
            return;
        }

        const players = await require("./kahootRedis").getPlayers(kahoot.id);

        await interaction.editReply({
            content:
                `🏆 **${kahoot.name} Leaderboard**\n\n` +
                buildLeaderboardText(players),
        });
    }
}

async function handleKahootModal(interaction) {
    if (!isStaff(interaction.user.id)) {
        return unauthorized(interaction);
    }

    const parts = interaction.customId.split(":");

    if (interaction.customId === "kahoot:modal:create") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const name = interaction.fields.getTextInputValue("name").trim();
        if (!name) {
            await interaction.editReply("❌ Kahoot name is required.");
            return;
        }

        const kahoot = await createKahoot({
            name,
            createdBy: interaction.user.id,
        });

        await interaction.editReply({
            content:
                `✅ Created **${kahoot.name}**.\n` +
                `ID: \`${kahoot.id}\`\n\n` +
                `Use **/kahoot → Add Question** to build the pool.`,
        });
        return;
    }

    if (parts[1] !== "modal") return;

    if (parts[2] === "participation") {
        const kahootId = parts[3];
        const kahoot = await getKahoot(kahootId);

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!kahoot) {
            await interaction.editReply("❌ Kahoot not found.");
            return;
        }

        try {
            const participation = Number(
                interaction.fields.getTextInputValue("participation").trim()
            );

            if (!Number.isInteger(participation) || participation < 0) {
                await interaction.editReply(
                    "❌ Participation reward must be a whole number of 0 or more."
                );
                return;
            }

            kahoot.rewards = {
                ...(kahoot.rewards || {}),
                participation,
            };

            await saveKahoot(kahoot);

            await interaction.editReply({
                content:
                    `💰 **${kahoot.name}** rewards updated successfully.\n\n` +
                    `🎁 Participation: **${participation} Mora**`,
            });
        } catch (error) {
            console.error("❌ Failed to update participation reward:", error);
            await interaction.editReply({
                content:
                    `❌ Failed to update participation reward: ${
                        error.message || "Unknown error."
                    }`,
            });
        }

        return;
    }

    if (parts[2] === "settings") {
        const kahootId = parts[3];
        const kahoot = await getKahoot(kahootId);

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!kahoot) {
            await interaction.editReply("❌ Kahoot not found.");
            return;
        }

        try {
            const questionTimer = Number(interaction.fields.getTextInputValue("questionTimer").trim());
            const leaderboardTimer = Number(interaction.fields.getTextInputValue("leaderboardTimer").trim());

            if (!Number.isInteger(questionTimer) || questionTimer < 1 || questionTimer > 3600) {
                await interaction.editReply("❌ Question timer must be a whole number between 1 and 3600 seconds.");
                return;
            }

            if (!Number.isInteger(leaderboardTimer) || leaderboardTimer < 1 || leaderboardTimer > 3600) {
                await interaction.editReply("❌ Leaderboard timer must be a whole number between 1 and 3600 seconds.");
                return;
            }

            kahoot.settings = {
                ...(kahoot.settings || {}),
                questionTimer,
                leaderboardTimer,
            };

            await saveKahoot(kahoot);

            await interaction.editReply({
                content:
                    `⚙️ **${kahoot.name}** timing updated.\n\n` +
                    `⏱️ Question: **${questionTimer}s**\n` +
                    `🏆 Leaderboard: **${leaderboardTimer}s**`,
            });
        } catch (error) {
            console.error("❌ Failed to update Kahoot settings:", error);
            await interaction.editReply({
                content: `❌ Failed to update settings: ${error.message || "Unknown error."}`,
            });
        }

        return;
    }

    if (parts[2] === "rewards") {
        const kahootId = parts[3];
        const kahoot = await getKahoot(kahootId);

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!kahoot) {
            await interaction.editReply("❌ Kahoot not found.");
            return;
        }

        try {
            const values = {};
            for (const id of ["first", "second", "third", "fourth", "fifth"]) {
                const value = Number(
                    interaction.fields.getTextInputValue(id).trim()
                );

                if (!Number.isInteger(value) || value < 0) {
                    await interaction.editReply(
                        `❌ ${id} place reward must be a whole number of 0 or more.`
                    );
                    return;
                }

                values[id] = value;
            }

            kahoot.rewards = {
                ...(kahoot.rewards || {}),
                ...values,
            };

            await saveKahoot(kahoot);

            await interaction.editReply({
                content:
                    "💰 Placement rewards saved temporarily. Click **Continue** to set the participation reward.",
                components: [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`kahoot:rewardscontinue:${kahoot.id}`)
                            .setLabel("Continue")
                            .setStyle(ButtonStyle.Primary)
                    ),
                ],
            });
        } catch (error) {
            console.error("❌ Kahoot rewards modal failed:", error);
            await interaction.editReply({
                content: `❌ Failed to save rewards: ${
                    error.message || "Unknown error."
                }`,
            });
        }

        return;
    }

    if (parts[2] === "q1") {
        const action = parts[3];
        const kahootId = parts[4];
        const questionId = parts[5] || "new";
        const kahoot = await getKahoot(kahootId);

        if (!kahoot) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await interaction.editReply("❌ Kahoot not found.");
            return;
        }

        const draftKey =
            `${interaction.user.id}:${action}:${kahootId}:${questionId}`;

        questionDrafts.set(draftKey, {
            question: interaction.fields.getTextInputValue("question"),
            options: [
                interaction.fields.getTextInputValue("answer1"),
                interaction.fields.getTextInputValue("answer2"),
                interaction.fields.getTextInputValue("answer3"),
                interaction.fields.getTextInputValue("answer4"),
            ],
        });

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        await interaction.editReply({
            content:
                "✅ Question and answers saved temporarily. Click **Continue** to enter the correct answer and optional image.",
            components: [
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(
                            `kahoot:continueq2:${action}:${kahootId}:${questionId}`
                        )
                        .setLabel("Continue")
                        .setStyle(ButtonStyle.Primary)
                ),
            ],
        });
        return;
    }

 if (parts[2] === "q2") {
    const action = parts[3];
    const kahootId = parts[4];
    const questionId = parts[5] === "new" ? null : parts[5];

    const kahoot = await getKahoot(kahootId);

    if (!kahoot) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.editReply("❌ Kahoot not found.");
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        if (action !== "addquestion" && action !== "modifyquestion") {
            await interaction.editReply("❌ Unknown Kahoot modal action.");
            return;
        }

        const draftKey =
            `${interaction.user.id}:${action}:${kahootId}:${questionId || "new"}`;

        const draft = questionDrafts.get(draftKey);

        if (!draft) {
            await interaction.editReply(
                "❌ Question draft expired. Please start again."
            );
            return;
        }

        const correctIndex =
            Number(interaction.fields.getTextInputValue("correct")) - 1;

        if (![0, 1, 2, 3].includes(correctIndex)) {
            await interaction.editReply(
                "❌ Correct answer must be 1, 2, 3, or 4."
            );
            return;
        }

        const data = {
            ...draft,
            correctIndex,
            imageUrl:
                interaction.fields.getTextInputValue("imageUrl").trim(),
        };

        let result;

        if (action === "addquestion") {
            result = await createQuestion(kahootId, data);
        } else {
            result = await modifyQuestion(kahootId, questionId, data);
        }

        questionDrafts.delete(draftKey);

        await interaction.editReply(
            action === "addquestion"
                ? `✅ Added Question **#${result.id}** to **${kahoot.name}**.`
                : `✅ Modified Question **#${result.id}**.`
        );
    } catch (error) {
        console.error("❌ Kahoot modal failed:", error);

        await interaction.editReply(
            `❌ ${error.message || "Failed to process request."}`
        );
    }

    return;
}

}

async function handleKahootSecondarySelect(interaction) {
    if (!isStaff(interaction.user.id)) {
        return unauthorized(interaction);
    }

    if (interaction.customId.startsWith("kahoot:modifyselect:")) {
        const kahootId = interaction.customId.split(":")[2];
        const questionId = interaction.values[0];
        const question = await require("./kahootRedis").getQuestion(
            kahootId,
            questionId
        );

        if (!question) {
            await interaction.reply({
                content: "❌ Question not found.",
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await interaction.showModal(
            questionModal(
                `kahoot:modal:q1:modifyquestion:${kahootId}:${questionId}`,
                "Modify Question",
                {
                    question: question.question,
                    answer1: question.options[0],
                    answer2: question.options[1],
                    answer3: question.options[2],
                    answer4: question.options[3],
                }
            )
        );
        return;
    }

    if (interaction.customId.startsWith("kahoot:deleteselect:")) {
        const kahootId = interaction.customId.split(":")[2];
        const questionId = interaction.values[0];

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        await removeQuestion(kahootId, questionId);

        await interaction.editReply({
            content: `🗑️ Question **#${questionId}** deleted.`,
        });
        return;
    }


}

async function handleKahootButton(interaction) {
    if (!interaction.customId.startsWith("kahoot:answer:")) return false;

    /*
     * ACK THE ANSWER BUTTON BEFORE ANY REDIS WORK.
     *
     * Discord gives us roughly 3 seconds to acknowledge an interaction.
     * This is intentionally done here, at the outermost Kahoot handler,
     * so module loading / game logic / Redis latency cannot consume that
     * acknowledgement window.
     */
    try {
        await interaction.deferReply({
            flags: MessageFlags.Ephemeral,
        });
    } catch (error) {
        // The interaction may genuinely be stale/expired. Do not let this
        // kill the Kahoot process or its timers.
        console.error(
            "⚠️ Kahoot answer interaction could not be acknowledged:",
            error.message || error
        );
        return true;
    }

    try {
        await submitAnswer(
            interaction.client,
            interaction,
            true
        );
    } catch (error) {
        console.error(
            "❌ Kahoot answer handler failed:",
            error.message || error
        );

        try {
            await interaction.editReply(
                "❌ Something went wrong while processing your answer."
            );
        } catch (replyError) {
            console.error(
                "⚠️ Could not send Kahoot error reply:",
                replyError.message || replyError
            );
        }
    }

    return true;
}

async function handleKahootInteraction(interaction) {
    if (interaction.isChatInputCommand() && interaction.commandName === "kahoot") {
        return handleKahootCommand(interaction);
    }

    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === "kahoot:action") {
            return handleKahootActionSelect(interaction);
        }

        if (interaction.customId.startsWith("kahoot:select:")) {
            return handleKahootSelect(interaction);
        }

        if (
            interaction.customId.startsWith("kahoot:modifyselect:") ||
            interaction.customId.startsWith("kahoot:deleteselect:")
        ) {
            return handleKahootSecondarySelect(interaction);
        }
    }

    if (
        interaction.isButton() &&
        interaction.customId.startsWith("kahoot:rewardscontinue:")
    ) {
        if (!isStaff(interaction.user.id)) {
            return unauthorized(interaction);
        }

        const kahootId = interaction.customId.split(":")[2];
        const kahoot = await getKahoot(kahootId);

        if (!kahoot) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await interaction.editReply("❌ Kahoot not found.");
            return;
        }

        await interaction.showModal(participationRewardsModal(kahoot));
        return;
    }

    if (
        interaction.isButton() &&
        interaction.customId.startsWith("kahoot:continueq2:")
    ) {
        if (!isStaff(interaction.user.id)) {
            return unauthorized(interaction);
        }

        const parts = interaction.customId.split(":");
        const action = parts[2];
        const kahootId = parts[3];
        const questionId = parts[4];

        await interaction.showModal(
            questionDetailsModal(
                `kahoot:modal:q2:${action}:${kahootId}:${questionId}`
            )
        );
        return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("kahoot:modal:")) {
        return handleKahootModal(interaction);
    }

    if (interaction.isButton() && interaction.customId.startsWith("kahoot:answer:")) {
        return handleKahootButton(interaction);
    }

    return false;
}

module.exports = {
    handleKahootCommand,
    handleKahootInteraction,
};

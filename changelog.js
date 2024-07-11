const { LinearClient } = require("@linear/sdk");
const OpenAI = require("openai");

const BATCH_SIZE = 15;
const LINEAR_TEAM = "Peach-technology";
const LINEAR_DONE_COLUMN = "Done";
const LINEAR_STAGING_COLUMN = "Staging";
const LINEAR_IN_REVIEW_COLUMN = "In Review";
const LINEAR_IN_PROGRESS_COLUMN = "In Progress";
const LINEAR_TODO_COLUMN = "To Do";

const PROJECT_LABELS = ["API", "Assessment Tool", "HQ", "Website"];

const linearClient = new LinearClient({
    apiKey: process.env["LINEAR_API_KEY"],
});

function isRateLimitError(error) {
    return typeof error.code === 'string';
}

async function summarise(tickets) {
    const openai = new OpenAI({
        apiKey: process.env["OPEN_AI_API_KEY"],
    });

    const prompt = `
  You are a product manager with a great technical background for a tech startup company making a release log of the tickets shipped by the company.

  The tickets are structured the following way:
  - An identifier, to recognise the ticket
  - A title, explaining the main goal of the ticket (it helps to understand the ticket general idea)
  - A description, explaining all the details and how to achieve the goal (it tells what the ticket does)
  - Some labels, to explain what the ticket is about (e.g. bug for a bug fix, product for a product feature, forest admin for an admin feature)
  - a priority, which tells how urgent the ticket was
  - an estimate, which tells how much work the ticket represented (estimate is between 1 and 7, 1 being small ticket and 7 being huge) - a ticket with high priority and high estimate is usually a key feature for the company
  - the person responsible for it (it's a name)
  - a url, to link to the ticket

  Each feature is grouped by project.

  Now given all the context you have, summarise a ticket in the json structure below:

  Json object should look something like this (it's json, and words between {{}} should be replaced with result along with the {{}}, so for example {{ticket url}} should give https://linear.app/collective-work/issue/E-3307/test):

  {
    "identifier": "{{ticket identifier}}",
    "url": "{{ticket url}}",
    "summary": "{{ticket summary}}",
    "category": "{{ticket category}}",
    "project": "{{ticket project}}"
  }

  where:
  - {{ticket identifier}} is just the identifier
  - {{ticket url}} is just the url
  - {{ticket summary}} is a quick summary of what the ticket solved or created - it must be a proper natural english sentence in the imperative mood (like a git commit message) and should not contain any weird structure like [] characters at the beginning (example of not tolerated "[Shortlister] Show not onboarded collectives", it should be instead "Show not onboarded collectives on the shortlister" or similar)
  - {{ticket category}} is ideally max 2 words (3 tolerated if hard to describe) describing the category/area of the ticket (for example, if the ticket is around improving the CI, then it should be "CI", if it is around Datadog test, it should be "Datadog", if it's about the Shortlister, then it should be "Shortlister")
  - {{ticket project}} is the project the ticket belongs to (can be any project name)

  here is an example of a ticket json object:

  {
    "identifier": "E-3306",
    "url": "https://linear.app/collective-work/issue/E-3306/update-prisma-to-v5",
    "summary": "Updated the database to its new major version",
    "category": "Database",
    "project": "API"
  }

  As there are multiple tickets, the result should JUST be a json array of objects as above, directly parsable.
  You should always return a json array, even if the array contains only one element - this is really important.

  Here are the tickets:
  `;

    let returnedContent = "";

    // Retry logic with exponential backoff
    const maxRetries = 5;
    let attempt = 0;

    while (attempt < maxRetries) {
        try {
            const result = await openai.chat.completions.create({
                messages: [
                    { role: "system", content: prompt },
                    { role: "user", content: tickets.join(`\n---\n`) },
                ],
                model: "gpt-3.5-turbo-16k",
                max_tokens: 2000,
            });

            returnedContent = result.choices?.[0]?.message?.content || "";
            break;
        } catch (error) {
            console.error("Error querying OpenAI API:", error);

            if (isRateLimitError(error) && (error.code === 'insufficient_quota' || error.code === 'rate_limit')) {
                const waitTime = Math.pow(2, attempt) * 1000;
                console.log(`Retrying in ${waitTime / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                attempt++;
            } else {
                throw error;
            }
        }
    }

    if (!returnedContent) {
        throw new Error('Failed to get a response from OpenAI API');
    }

    try {
        let parsedContent = JSON.parse(returnedContent);

        if (!Array.isArray(parsedContent)) {
            parsedContent = [parsedContent];
        }

        return parsedContent;
    } catch (error) {
        console.error("Error parsing OpenAI API response:", error);
        return [];
    }
}

async function getAllProjects() {
    let projects = [];

    try {
        const allProjects = await linearClient.projects({
            filter: {
                state: { eq: "active" }
            }
        });

        projects = allProjects.nodes;
        console.log(`Found ${projects.length} active projects...`);
    } catch (error) {
        console.error(`Error fetching projects`, error);
    }

    return projects;
}

async function getAllTicketsForProject(project, columnName) {
    let tickets = [];

    try {
        const allIssues = await linearClient.issues({
            filter: {
                and: [
                    {
                        team: { name: { eq: LINEAR_TEAM } },
                        project: { id: { eq: project.id } },
                        state: { name: { eq: columnName } },
                        updatedAt: { gte: new Date(Date.now() - 12096e5) },
                    },
                ],
            },
            first: 250,
        });

        const totalTicketCount = allIssues.nodes.length;

        if (allIssues && totalTicketCount) {
            console.log(`Found ${totalTicketCount} tickets in project ${project.name} under column ${columnName}...`);
            tickets = allIssues.nodes;
        } else {
            console.log(`No issues found in project ${project.name} under column ${columnName}`);
        }
    } catch (error) {
        console.error(`Error fetching issues for project ${project.name} from column ${columnName}`, error);
    }

    return tickets;
}

async function getAllUnprojectedTickets(columnName) {
    let tickets = [];

    try {
        const allIssues = await linearClient.issues({
            filter: {
                and: [
                    {
                        team: { name: { eq: LINEAR_TEAM } },
                        state: { name: { eq: columnName } },
                        project: { id: { null: true } },
                        updatedAt: { gte: new Date(Date.now() - 12096e5) },
                    },
                ],
            },
            first: 250,
        });

        const totalTicketCount = allIssues.nodes.length;

        if (allIssues && totalTicketCount) {
            console.log(`Found ${totalTicketCount} unprojected tickets in column ${columnName}...`);
            tickets = allIssues.nodes;
        } else {
            console.log(`No unprojected issues found in column ${columnName}`);
        }
    } catch (error) {
        console.error(`Error fetching unprojected issues from column ${columnName}`, error);
    }

    return tickets;
}

async function summariseTickets(tickets) {
    let summarisedTickets = [];
    const totalTicketCount = tickets.length;

    console.log(`Summarising ${totalTicketCount} tickets...`);

    for (let i = 0; i < totalTicketCount; i += BATCH_SIZE) {
        const batch = tickets.slice(i, i + BATCH_SIZE).map(async (ticket) => {
            const assignee = await ticket.assignee;
            const labels = await ticket.labels();
            const project = await ticket.project;
            const projectLabel = project ? project.name : (labels.nodes.some(label => label.name === "bug") ? "Bug" : "Enhancement");

            return `
        - Ticket identifier: ${ticket.identifier}
        - Ticket title: ${ticket.title}
        - Ticket priority: ${ticket.priorityLabel}
        - Ticket estimate: ${ticket.estimate}
        - Person responsible for the ticket: ${assignee?.name || ""}
        - Labels of the ticket: ${labels.nodes.map((label) => label.name).join(", ")}
        - Url of the ticket: ${ticket.url}
        - Ticket description: ${ticket.description}
        - Project: ${projectLabel}
      `;
        });

        const ticketBatch = await Promise.all(batch);

        console.log(`Summarising ${ticketBatch.length} tickets - batch: [${i}, ${i + BATCH_SIZE}] out of ${totalTicketCount}...`);

        const summarisedTicketBatch = await summarise(ticketBatch);

        console.log("Summarised results:");
        console.log(`${JSON.stringify(summarisedTicketBatch)}`);

        summarisedTickets = [...summarisedTickets, ...summarisedTicketBatch];
    }

    return summarisedTickets;
}

function formatReleaseNote(tickets) {
    let groupedTickets = tickets.reduce((group, ticket) => {
        let projectName = ticket.project;

        if (!group[projectName]) {
            group[projectName] = [];
        }

        group[projectName].push(ticket);

        return group;
    }, {});

    let resultString = "";

    Object.keys(groupedTickets).forEach((projectName) => {
        resultString += `*${projectName}*:\n`;

        if (groupedTickets[projectName]) {
            groupedTickets[projectName].forEach((ticket) => {
                resultString += `[${ticket.category}] ${ticket.summary} - [${ticket.identifier}](${ticket.url})\n`;
            });
        }

        console.log(`Found ${(groupedTickets[projectName] || []).length} tickets for project ${projectName}`);

        resultString += "\n";
    });

    if (groupedTickets["Enhancement"]) {
        resultString += "*Enhancements*:\n";
        groupedTickets["Enhancement"].forEach((ticket) => {
            resultString += `[${ticket.category}] ${ticket.summary} - [${ticket.identifier}](${ticket.url})\n`;
        });
        resultString += "\n";
    }

    return resultString;
}

async function generateReleaseNote() {
    const projects = await getAllProjects();
    let allTickets = [];

    for (const project of projects) {
        const doneTickets = await getAllTicketsForProject(project, LINEAR_DONE_COLUMN);
        const stagingTickets = await getAllTicketsForProject(project, LINEAR_STAGING_COLUMN);
        const inReviewTickets = await getAllTicketsForProject(project, LINEAR_IN_REVIEW_COLUMN);
        const inProgressTickets = await getAllTicketsForProject(project, LINEAR_IN_PROGRESS_COLUMN);
        const todoTickets = await getAllTicketsForProject(project, LINEAR_TODO_COLUMN);

        allTickets = allTickets.concat(doneTickets, stagingTickets, inReviewTickets, inProgressTickets, todoTickets);
    }

    const unprojectedDoneTickets = await getAllUnprojectedTickets(LINEAR_DONE_COLUMN);
    const unprojectedStagingTickets = await getAllUnprojectedTickets(LINEAR_STAGING_COLUMN);
    const unprojectedInReviewTickets = await getAllUnprojectedTickets(LINEAR_IN_REVIEW_COLUMN);
    const unprojectedInProgressTickets = await getAllUnprojectedTickets(LINEAR_IN_PROGRESS_COLUMN);
    const unprojectedTodoTickets = await getAllUnprojectedTickets(LINEAR_TODO_COLUMN);

    allTickets = allTickets.concat(unprojectedDoneTickets, unprojectedStagingTickets, unprojectedInReviewTickets, unprojectedInProgressTickets, unprojectedTodoTickets);

    const summarisedTickets = await summariseTickets(allTickets);

    const releaseNote = formatReleaseNote(summarisedTickets);

    console.log("\nFinal release note:\n");
    console.log(releaseNote);
}

generateReleaseNote();

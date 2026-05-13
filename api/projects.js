const DEFAULT_REPO = "bella07021/meteora-dlmm-standard-pool-calculator";
const DEFAULT_BRANCH = "main";
const DEFAULT_PATH = "data/projects.json";

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function requiredEnv() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return {
    token,
    repo: process.env.GITHUB_REPO || DEFAULT_REPO,
    branch: process.env.GITHUB_BRANCH || DEFAULT_BRANCH,
    path: process.env.PROJECTS_JSON_PATH || DEFAULT_PATH,
  };
}

async function githubRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = payload?.message || `GitHub request failed: ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

async function readProjects(config) {
  const url = `https://api.github.com/repos/${config.repo}/contents/${config.path}?ref=${config.branch}`;
  try {
    const file = await githubRequest(url, {
      headers: { Authorization: `Bearer ${config.token}` },
    });
    const content = Buffer.from(file.content || "", "base64").toString("utf8");
    return {
      projects: content.trim() ? JSON.parse(content) : {},
      sha: file.sha,
    };
  } catch (error) {
    if (String(error.message).includes("Not Found")) return { projects: {}, sha: null };
    throw error;
  }
}

async function writeProjects(config, projects, sha) {
  const url = `https://api.github.com/repos/${config.repo}/contents/${config.path}`;
  const body = {
    message: "Update saved DLMM projects",
    branch: config.branch,
    content: Buffer.from(`${JSON.stringify(projects, null, 2)}\n`, "utf8").toString("base64"),
  };
  if (sha) body.sha = sha;
  await githubRequest(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

module.exports = async function handler(req, res) {
  const config = requiredEnv();
  if (!config.token) {
    json(res, 503, { error: "远端项目库未配置：缺少 GITHUB_TOKEN。" });
    return;
  }

  try {
    if (req.method === "GET") {
      const { projects } = await readProjects(config);
      json(res, 200, { projects });
      return;
    }

    if (req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const name = String(body.name || "").trim();
      if (!name) {
        json(res, 400, { error: "项目名称不能为空。" });
        return;
      }
      const { projects, sha } = await readProjects(config);
      projects[name] = body.project;
      await writeProjects(config, projects, sha);
      json(res, 200, { projects });
      return;
    }

    res.setHeader("Allow", "GET, POST");
    json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    json(res, 500, { error: error.message || "项目保存失败。" });
  }
};

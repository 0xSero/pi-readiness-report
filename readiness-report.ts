import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import fs from "node:fs";
import path from "node:path";

type AppInfo = {
	name: string;
	path: string;
	relativePath: string;
	type: string;
	description?: string;
	packageJson?: Record<string, unknown>;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};

type CriterionTier = "BASIC" | "INTERMEDIATE" | "ADVANCED";

type Criterion = {
	id: string;
	category: string;
	tier: CriterionTier;
	level: number;
	title: string;
	description: string;
	recommendation: string;
	scope: "repo" | "app";
	checkRepo?: (repo: RepoContext) => CheckResult;
	checkApp?: (app: AppInfo, repo: RepoContext) => CheckResult;
};

type CheckStatus = "pass" | "fail" | "na";

type CheckResult = {
	status: CheckStatus;
	details: string;
};

type CriterionResult = {
	id: string;
	category: string;
	tier: CriterionTier;
	level: number;
	title: string;
	description: string;
	recommendation: string;
	scope: "repo" | "app";
	numerator: number;
	denominator: number;
	passed: boolean;
	applicable: boolean;
	reasons: { target: string; status: CheckStatus; details: string }[];
};

type RepoContext = {
	root: string;
	repoName: string;
	languages: string[];
	apps: AppInfo[];
	files: Set<string>;
	workflows: string[];
	readme?: string;
};

type Report = {
	generatedAt: string;
	repoRoot: string;
	repoName: string;
	languages: string[];
	apps: AppInfo[];
	model?: { provider: string; id: string };
	aiPrompt?: string;
	maturity: {
		levelAchieved: number;
		score: number;
		passRate: number;
		criteriaPassed: number;
		criteriaTotal: number;
		checksPassed: number;
		checksTotal: number;
		levelScores: { level: number; passed: number; total: number; passRate: number }[];
	};
	categories: { name: string; passed: number; total: number; passRate: number | null }[];
	history: { generatedAt: string; level: number; score: number }[];
	criteria: CriterionResult[];
	actionItems: { title: string; recommendation: string; level: number }[];
	paths: { html: string; json: string; md: string };
};

const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".pi", "dist", "build", "out", ".next", "coverage"]);
const MAX_WALK_DEPTH = 4;

type ModelRef = { provider: string; id: string };

let lastSelectedModel: ModelRef | undefined;

const parseModelArg = (args: string) => {
	const tokens = args.split(/\s+/).filter(Boolean);
	const modelToken = tokens.find((token) => token.startsWith("model="));
	if (modelToken) {
		return modelToken.replace("model=", "").trim();
	}
	const modelIndex = tokens.findIndex((token) => token === "--model");
	if (modelIndex >= 0 && tokens[modelIndex + 1]) {
		return tokens[modelIndex + 1].trim();
	}
	return undefined;
};

const resolveModelRef = (ctx: ExtensionCommandContext, args: string) => {
	const explicit = parseModelArg(args);
	const fromCtx = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	const fromLast = lastSelectedModel ? `${lastSelectedModel.provider}/${lastSelectedModel.id}` : undefined;
	const modelId = explicit ?? fromCtx ?? fromLast;
	if (!modelId) return undefined;
	const [provider, id] = modelId.split("/");
	if (!provider || !id) return undefined;
	return { provider, id } satisfies ModelRef;
};

const tierToLevel: Record<CriterionTier, number> = {
	BASIC: 1,
	INTERMEDIATE: 3,
	ADVANCED: 5,
};

const passResult = (details: string): CheckResult => ({ status: "pass", details });
const failResult = (details: string): CheckResult => ({ status: "fail", details });
const naResult = (details: string): CheckResult => ({ status: "na", details });

const fileExists = (value: string) => {
	try {
		return fs.existsSync(value);
	} catch {
		return false;
	}
};

const readText = (value: string) => {
	try {
		return fs.readFileSync(value, "utf8");
	} catch {
		return undefined;
	}
};

const readJson = (value: string) => {
	try {
		return JSON.parse(fs.readFileSync(value, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
};

const listFiles = (dir: string) => {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
};

const walkDirs = (dir: string, depth = 0, results: string[] = []) => {
	if (depth > MAX_WALK_DEPTH) return results;
	for (const entry of listFiles(dir)) {
		if (!entry.isDirectory()) continue;
		if (EXCLUDED_DIRS.has(entry.name)) continue;
		const next = path.join(dir, entry.name);
		results.push(next);
		walkDirs(next, depth + 1, results);
	}
	return results;
};

const getRepoRoot = async (pi: ExtensionAPI, ctx: ExtensionCommandContext) => {
	try {
		const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 3000 });
		if (result.code === 0 && result.stdout.trim()) {
			return result.stdout.trim();
		}
	} catch {
		// ignore
	}
	return ctx.cwd ?? process.cwd();
};

const detectLanguages = (repoRoot: string) => {
	const languages = new Set<string>();
	const addIf = (name: string, fileNames: string[]) => {
		for (const fileName of fileNames) {
			if (fileExists(path.join(repoRoot, fileName))) {
				languages.add(name);
				return;
			}
		}
	};
	addIf("JavaScript/TypeScript", ["package.json", "tsconfig.json", "jsconfig.json"]);
	addIf("Python", ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"]);
	addIf("Rust", ["Cargo.toml"]);
	addIf("Go", ["go.mod"]);
	addIf("Java", ["pom.xml", "build.gradle", "build.gradle.kts"]);
	addIf("Ruby", ["Gemfile"]);
	return Array.from(languages);
};

const detectAppType = (app: AppInfo) => {
	const deps = { ...(app.dependencies ?? {}), ...(app.devDependencies ?? {}) };
	const keys = Object.keys(deps);
	const hasAny = (names: string[]) => names.some((name) => keys.includes(name));
	if (fileExists(path.join(app.path, "next.config.js")) || fileExists(path.join(app.path, "next.config.mjs"))) {
		return "web";
	}
	if (hasAny(["next", "react", "vite", "webpack", "svelte"])) return "web";
	if (hasAny(["express", "fastify", "koa", "nestjs"])) return "service";
	if (hasAny(["react-native", "expo"])) return "mobile";
	return "library";
};

const discoverApps = (repoRoot: string) => {
	const apps: AppInfo[] = [];
	const rootPackage = readJson(path.join(repoRoot, "package.json"));
	const dirs = walkDirs(repoRoot);
	for (const dir of dirs) {
		const pkgPath = path.join(dir, "package.json");
		if (!fileExists(pkgPath)) continue;
		if (path.resolve(dir) === path.resolve(repoRoot)) continue;
		const pkg = readJson(pkgPath) ?? {};
		const name = typeof pkg.name === "string" ? pkg.name : path.basename(dir);
		const description = typeof pkg.description === "string" ? pkg.description : undefined;
		const scripts = typeof pkg.scripts === "object" && pkg.scripts ? (pkg.scripts as Record<string, string>) : undefined;
		const dependencies = typeof pkg.dependencies === "object" && pkg.dependencies ? (pkg.dependencies as Record<string, string>) : undefined;
		const devDependencies =
			typeof pkg.devDependencies === "object" && pkg.devDependencies ? (pkg.devDependencies as Record<string, string>) : undefined;
		apps.push({
			name,
			path: dir,
			relativePath: path.relative(repoRoot, dir),
			type: "unknown",
			description,
			packageJson: pkg,
			scripts,
			dependencies,
			devDependencies,
		});
	}

	if (apps.length === 0 && rootPackage) {
		const name = typeof rootPackage.name === "string" ? rootPackage.name : path.basename(repoRoot);
		const description = typeof rootPackage.description === "string" ? rootPackage.description : undefined;
		const scripts =
			typeof rootPackage.scripts === "object" && rootPackage.scripts
				? (rootPackage.scripts as Record<string, string>)
				: undefined;
		const dependencies =
			typeof rootPackage.dependencies === "object" && rootPackage.dependencies
				? (rootPackage.dependencies as Record<string, string>)
				: undefined;
		const devDependencies =
			typeof rootPackage.devDependencies === "object" && rootPackage.devDependencies
				? (rootPackage.devDependencies as Record<string, string>)
				: undefined;
		apps.push({
			name,
			path: repoRoot,
			relativePath: ".",
			type: "unknown",
			description,
			packageJson: rootPackage,
			scripts,
			dependencies,
			devDependencies,
		});
	}

	for (const app of apps) {
		app.type = detectAppType(app);
	}

	return apps;
};

const getRepoFiles = (repoRoot: string) => {
	const files = new Set<string>();
	for (const entry of listFiles(repoRoot)) {
		files.add(entry.name);
	}
	return files;
};

const getWorkflowFiles = (repoRoot: string) => {
	const workflowDir = path.join(repoRoot, ".github", "workflows");
	if (!fileExists(workflowDir)) return [];
	return listFiles(workflowDir)
		.filter((file) => file.isFile() && file.name.match(/\.ya?ml$/))
		.map((file) => path.join(workflowDir, file.name));
};

const hasAnyFile = (root: string, candidates: string[]) => candidates.some((name) => fileExists(path.join(root, name)));

const hasTestFiles = (root: string) => {
	return ["test", "tests", "__tests__", "spec"].some((dir) => fileExists(path.join(root, dir)));
};

const hasLintConfig = (root: string, app: AppInfo) => {
	const lintFiles = [
		".eslintrc",
		".eslintrc.js",
		".eslintrc.cjs",
		".eslintrc.json",
		".prettierrc",
		".prettierrc.js",
		".prettierrc.cjs",
		".prettierrc.json",
		"prettier.config.js",
		"prettier.config.cjs",
		"ruff.toml",
	];
	const scripts = app.scripts ?? {};
	const hasScript = ["lint", "format"].some((key) => scripts[key]);
	const pkg = app.packageJson ?? {};
	const hasPkgConfig = Boolean(pkg.eslintConfig || pkg.prettier);
	return hasScript || hasPkgConfig || lintFiles.some((name) => fileExists(path.join(root, name)));
};

const hasTypeCheckConfig = (root: string, app: AppInfo) => {
	const scripts = app.scripts ?? {};
	const hasScript = ["typecheck", "check", "lint:types"].some((key) => scripts[key]);
	return (
		hasScript ||
		hasAnyFile(root, ["tsconfig.json", "tsconfig.base.json", "jsconfig.json", "mypy.ini", "pyrightconfig.json"])
	);
};

const hasCoverageConfig = (root: string, app: AppInfo) => {
	const scripts = app.scripts ?? {};
	const hasScript = ["coverage", "test:coverage"].some((key) => scripts[key]);
	return hasScript || hasAnyFile(root, ["nyc.config.js", "nyc.config.cjs", "jest.config.js", "jest.config.ts"]) ||
		!!(app.packageJson && (app.packageJson.nyc || app.packageJson.jest));
};

const hasPreCommitHooks = (repoRoot: string) => {
	return (
		fileExists(path.join(repoRoot, ".husky")) ||
		hasAnyFile(repoRoot, [".lintstagedrc", ".lintstagedrc.js", ".lintstagedrc.cjs", ".pre-commit-config.yaml"]) ||
		(() => {
			const pkg = readJson(path.join(repoRoot, "package.json"));
			return Boolean(pkg && (pkg["lint-staged"] || pkg["husky"]));
		})()
	);
};

const hasReleaseAutomation = (repoRoot: string) => {
	return (
		fileExists(path.join(repoRoot, ".changeset")) ||
		hasAnyFile(repoRoot, [".releaserc", ".releaserc.json", "release.config.js", "changeset.config.js"]) ||
		(() => {
			const pkg = readJson(path.join(repoRoot, "package.json"));
			return Boolean(pkg && (pkg["release"] || pkg["changeset"] || pkg["semantic-release"]));
		})()
	);
};

const hasDependencyAutomation = (repoRoot: string) => {
	return hasAnyFile(repoRoot, ["renovate.json", "renovate.json5"]) || fileExists(path.join(repoRoot, ".github", "dependabot.yml"));
};

const hasRunbooks = (repoRoot: string) => {
	return (
		fileExists(path.join(repoRoot, "docs", "runbook")) ||
		hasAnyFile(repoRoot, ["runbook.md", "RUNBOOK.md", "ops.md", "OPERATIONS.md"]) ||
		fileExists(path.join(repoRoot, "ops"))
	);
};

const hasScheduledAutomation = (workflows: string[]) => {
	return workflows.some((file) => {
		const content = readText(file);
		return content ? content.includes("schedule:") : false;
	});
};

const hasSetupInstructions = (readme?: string) => {
	if (!readme) return false;
	const text = readme.toLowerCase();
	return ["install", "setup", "usage", "getting started"].some((word) => text.includes(word));
};

const getDependencies = (app: AppInfo) => ({ ...(app.dependencies ?? {}), ...(app.devDependencies ?? {}) });

const hasAnyDependency = (app: AppInfo, names: string[]) => {
	const deps = Object.keys(getDependencies(app));
	return names.some((name) => deps.includes(name));
};

const hasAnyDependencyAcrossApps = (apps: AppInfo[], names: string[]) => apps.some((app) => hasAnyDependency(app, names));

const hasAnyFileInPaths = (paths: string[], names: string[]) =>
	paths.some((base) => names.some((name) => fileExists(path.join(base, name))));

const readWorkflowContents = (workflows: string[]) => workflows.map((file) => readText(file) ?? "").join("\n");

const hasWorkflowMatch = (workflows: string[], matcher: RegExp) =>
	workflows.some((file) => {
		const content = readText(file);
		return content ? matcher.test(content) : false;
	});

const walkFiles = (dir: string, depth = 0, results: string[] = []) => {
	if (depth > MAX_WALK_DEPTH) return results;
	for (const entry of listFiles(dir)) {
		if (entry.name.startsWith(".")) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (EXCLUDED_DIRS.has(entry.name)) continue;
			walkFiles(full, depth + 1, results);
		} else if (entry.isFile()) {
			results.push(full);
		}
	}
	return results;
};

const walkFilesAll = (dir: string, results: string[] = []) => {
	for (const entry of listFiles(dir)) {
		if (entry.name.startsWith(".")) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (EXCLUDED_DIRS.has(entry.name)) continue;
			walkFilesAll(full, results);
		} else if (entry.isFile()) {
			results.push(full);
		}
	}
	return results;
};

const hasMatchingFile = (dir: string, matcher: RegExp) => walkFiles(dir).some((file) => matcher.test(file));

const formatScore = (numerator: number, denominator: number) => (denominator === 0 ? "N/A" : `${numerator}/${denominator}`);

const buildRepoSnapshot = (repoRoot: string, maxFiles = 2000, maxLargestFiles = 8, maxChars = 4000) => {
	const files = walkFilesAll(repoRoot).slice(0, maxFiles);
	const tree = files.map((file) => path.relative(repoRoot, file)).sort();
	const largest = files
		.map((file) => {
			try {
				const stat = fs.statSync(file);
				return { file, size: stat.size };
			} catch {
				return { file, size: 0 };
			}
		})
		.sort((a, b) => b.size - a.size)
		.slice(0, maxLargestFiles)
		.map((entry) => {
			const content = readText(entry.file) ?? "";
			const snippet = content.slice(0, maxChars);
			return {
				path: path.relative(repoRoot, entry.file),
				size: entry.size,
				snippet: snippet || "<binary or empty>",
			};
		});

	return [
		"FILE TREE (truncated if huge):",
		...tree,
		"",
		"LARGEST FILES (truncated snippets):",
		...largest.map((entry) => `# ${entry.path} (${entry.size} bytes)\n${entry.snippet}`),
	].join("\n");
};

const hasCodeFormatter = (root: string, app: AppInfo) =>
	hasAnyFile(root, [".prettierrc", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.json", "prettier.config.js", "prettier.config.cjs"]) ||
	hasAnyFile(app.path, [".prettierrc", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.json", "prettier.config.js", "prettier.config.cjs"]) ||
	Boolean(app.packageJson && app.packageJson.prettier);

const hasStrictTyping = (root: string, app: AppInfo) => {
	if (fileExists(path.join(root, "tsconfig.json"))) {
		const config = readJson(path.join(root, "tsconfig.json"));
		if (config && typeof config === "object") {
			const compilerOptions = (config as Record<string, unknown>).compilerOptions as Record<string, unknown> | undefined;
			if (compilerOptions && compilerOptions.strict === true) return true;
		}
	}
	return hasAnyFile(app.path, ["mypy.ini", "pyrightconfig.json"]);
};

const hasNamingConsistency = (root: string, app: AppInfo) => {
	const config = readText(path.join(root, ".eslintrc")) ?? readText(path.join(root, ".eslintrc.json"));
	return Boolean(config && /(naming-convention|camelcase|unicorn\/filename-case)/.test(config));
};

const hasDeadCodeDetection = (app: AppInfo) =>
	hasAnyDependency(app, ["ts-prune", "depcheck", "eslint-plugin-unused-imports", "knip"]);

const hasTechDebtTracking = (root: string) =>
	hasAnyFile(root, ["sonar-project.properties", "codeclimate.yml"]) || fileExists(path.join(root, ".github", "workflows", "codeql.yml"));

const hasNPlusOneDetection = (apps: AppInfo[]) =>
	hasAnyDependencyAcrossApps(apps, ["nplusone", "bullet", "pghero", "django-silk"]);

const hasCyclomaticComplexity = (root: string) => {
	const config = readText(path.join(root, ".eslintrc")) ?? readText(path.join(root, ".eslintrc.json"));
	return Boolean(config && /complexity/.test(config));
};

const hasDuplicateCodeDetection = (apps: AppInfo[]) => hasAnyDependencyAcrossApps(apps, ["jscpd", "sonarqube-scanner"]);

const hasModularizationEnforcement = (apps: AppInfo[]) =>
	hasAnyDependencyAcrossApps(apps, ["eslint-plugin-boundaries", "eslint-plugin-import", "dependency-cruiser"]);

const hasLargeFileDetection = (root: string) => {
	const attrs = readText(path.join(root, ".gitattributes"));
	return Boolean(attrs && /filter=lfs/.test(attrs));
};

const hasAutomatedPrReview = (workflows: string[]) =>
	hasWorkflowMatch(workflows, /(code-review|reviewdog|pull_request).*?review/i);

const hasDeploymentFrequency = (workflows: string[]) => hasWorkflowMatch(workflows, /deploy/i);

const hasFeatureFlagInfra = (apps: AppInfo[]) =>
	hasAnyDependencyAcrossApps(apps, ["launchdarkly", "unleash", "configcat", "growthbook", "flagsmith"]);

const hasMonorepoTooling = (root: string, apps: AppInfo[]) =>
	apps.length > 1 ||
	hasAnyFile(root, ["pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json", "rush.json"]);

const hasVersionDriftDetection = (root: string) => hasAnyFile(root, ["syncpack.config.js", ".syncpackrc", "changeset.config.js"]);

const hasHeavyDependencyDetection = (apps: AppInfo[]) =>
	hasAnyDependencyAcrossApps(apps, ["bundlewatch", "size-limit", "webpack-bundle-analyzer"]);

const hasBuildCommandDocumentation = (readme?: string) => readme ? /build/.test(readme.toLowerCase()) : false;

const hasDependenciesPinned = (root: string) =>
	hasAnyFile(root, ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock", "Cargo.lock", "Gemfile.lock"]);

const hasVcsCliTools = (root: string) =>
	hasAnyFile(root, [".github" ]) || Boolean(readText(path.join(root, "README.md"))?.includes("gh "));

const hasAgenticDevelopment = (root: string) => fileExists(path.join(root, "AGENTS.md")) || fileExists(path.join(root, ".pi"));

const hasSingleCommandSetup = (apps: AppInfo[]) =>
	apps.some((app) => (app.scripts ?? {}).setup || (app.scripts ?? {}).bootstrap);

const hasReleaseNotesAutomation = (root: string) =>
	hasAnyFile(root, [".changeset", "release-please-config.json", ".release-please-manifest.json"]);

const hasUnusedDependenciesDetection = (apps: AppInfo[]) => hasAnyDependencyAcrossApps(apps, ["depcheck", "knip"]);

const hasFastCiFeedback = (workflows: string[]) => hasWorkflowMatch(workflows, /(cache|matrix|parallel)/i);
const hasBuildPerfTracking = (workflows: string[]) => hasWorkflowMatch(workflows, /(build performance|perf|timing)/i);
const hasProgressiveRollout = (workflows: string[]) => hasWorkflowMatch(workflows, /(canary|progressive|rollout)/i);
const hasRollbackAutomation = (workflows: string[]) => hasWorkflowMatch(workflows, /(rollback|roll back)/i);
const hasDeadFeatureFlagDetection = (apps: AppInfo[]) =>
	hasAnyDependencyAcrossApps(apps, ["launchdarkly", "unleash"]) && hasMatchingFile(process.cwd(), /flag.*dead/i);

const hasTestCoverageThresholds = (root: string) => {
	const jestConfig = readText(path.join(root, "jest.config.js")) ?? readText(path.join(root, "jest.config.ts"));
	return Boolean(jestConfig && /coverageThreshold/.test(jestConfig));
};

const hasIntegrationTests = (root: string, app: AppInfo) =>
	hasAnyFile(app.path, ["integration", "__integration__"]) || Boolean((app.scripts ?? {})["test:integration"]);

const hasTestFileNaming = (root: string) => hasMatchingFile(root, /\.(test|spec)\.[jt]sx?$/);

const hasFlakyTestDetection = (apps: AppInfo[]) => hasAnyDependencyAcrossApps(apps, ["flaky", "jest-retries", "retry"]);

const hasTestIsolation = (apps: AppInfo[]) => hasAnyDependencyAcrossApps(apps, ["testcontainers", "toxiproxy"]) ||
	hasMatchingFile(process.cwd(), /testcontainers|sandbox/i);

const hasTestPerformanceTracking = (apps: AppInfo[]) => hasAnyDependencyAcrossApps(apps, ["jest-performance", "pytest-benchmark"]);

const hasSkillsConfig = (root: string) => fileExists(path.join(root, ".pi", "skills")) || fileExists(path.join(root, ".claude", "skills"));

const hasApiSchemaDocs = (root: string) =>
	hasAnyFile(root, ["openapi.yaml", "openapi.yml", "swagger.json", "schema.graphql", "api.md"]);

const hasAgentsFreshnessValidation = (workflows: string[]) => hasWorkflowMatch(workflows, /agents\.md/i);

const hasDocumentationFreshness = (root: string) => {
	try {
		const docsPath = path.join(root, "docs");
		if (!fileExists(docsPath)) return false;
		const files = walkFiles(docsPath);
		const cutoff = Date.now() - 1000 * 60 * 60 * 24 * 180;
		return files.some((file) => fs.statSync(file).mtimeMs >= cutoff);
	} catch {
		return false;
	}
};

const hasServiceArchitectureDoc = (root: string) =>
	hasAnyFile(root, ["architecture.md", "ARCHITECTURE.md"]) || fileExists(path.join(root, "docs", "architecture"));

const hasAutoDocsGeneration = (apps: AppInfo[]) =>
	hasAnyDependencyAcrossApps(apps, ["typedoc", "swagger-jsdoc", "redoc", "docusaurus"]) || fileExists(path.join(process.cwd(), "docs", "site"));

const hasDevContainer = (root: string) => fileExists(path.join(root, ".devcontainer"));

const hasDatabaseSchema = (root: string) =>
	hasAnyFile(root, ["schema.prisma", "schema.sql", "dbschema.json"]) || fileExists(path.join(root, "migrations"));

const hasEnvTemplate = (root: string) => hasAnyFile(root, [".env.example", ".env.template", "env.example"]);

const hasLocalServicesSetup = (root: string) => hasAnyFile(root, ["docker-compose.yml", "docker-compose.yaml"]) || fileExists(path.join(root, "compose.yaml"));

const hasStructuredLogging = (apps: AppInfo[]) =>
	hasAnyDependencyAcrossApps(apps, ["pino", "winston", "bunyan", "loguru", "structlog"]);

const hasDistributedTracing = (apps: AppInfo[]) =>
	hasAnyDependencyAcrossApps(apps, ["@opentelemetry/api", "opentelemetry", "dd-trace", "newrelic"]);

const hasCodeQualityDashboard = (root: string) => hasAnyFile(root, ["sonar-project.properties", "codeclimate.yml"]);

const hasErrorTracking = (apps: AppInfo[]) => hasAnyDependencyAcrossApps(apps, ["@sentry/node", "@sentry/react", "bugsnag", "rollbar"]);

const hasAlertingConfigured = (root: string) => hasAnyFile(root, [".pagerduty.yml", "alertmanager.yml"]);

const hasMetricsCollection = (apps: AppInfo[]) =>
	hasAnyDependencyAcrossApps(apps, ["prom-client", "opentelemetry", "statsd", "dd-trace"]);

const hasDeploymentObservability = (workflows: string[]) => hasWorkflowMatch(workflows, /(datadog|newrelic|sentry)/i);

const hasHealthChecks = (root: string) => hasMatchingFile(root, /(health|status).*\.(js|ts|py|go|rb)/i);

const hasCircuitBreakers = (apps: AppInfo[]) => hasAnyDependencyAcrossApps(apps, ["opossum", "cockatiel", "resilience4j"]);

const hasProfilingInstrumentation = (apps: AppInfo[]) => hasAnyDependencyAcrossApps(apps, ["clinic", "pprof", "py-spy"]);

const hasBranchProtection = (root: string) => hasAnyFile(root, [".github", "settings.yml", "settings.yaml"]);

const hasSecretScanning = (root: string) => hasAnyFile(root, [".gitleaks.toml", "gitleaks.toml", ".trivy.yml"]);

const hasCodeowners = (root: string) =>
	hasAnyFile(root, ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]);

const hasAutomatedSecurityReview = (workflows: string[]) => hasWorkflowMatch(workflows, /(codeql|security)/i);

const hasSensitiveDataScrubbing = (apps: AppInfo[]) => hasAnyDependencyAcrossApps(apps, ["@sentry/node", "pino", "winston"]);

const hasGitignoreComprehensive = (root: string) => fileExists(path.join(root, ".gitignore"));

const hasSecretsManagement = (apps: AppInfo[]) =>
	hasAnyDependencyAcrossApps(apps, ["@aws-sdk/client-secrets-manager", "vault", "doppler"]) || fileExists(path.join(process.cwd(), ".env"));

const hasDastScanning = (workflows: string[]) => hasWorkflowMatch(workflows, /(zap|dast)/i);

const hasPiiHandling = (root: string) => hasAnyFile(root, ["PII.md", "privacy.md"]);

const hasPrivacyCompliance = (root: string) => hasAnyFile(root, ["gdpr.md", "SOC2.md"]);

const hasIssueTemplates = (root: string) => fileExists(path.join(root, ".github", "ISSUE_TEMPLATE"));

const hasIssueLabelingSystem = (root: string) => hasAnyFile(root, [".github/labels.yml", ".github/labels.json"]);

const hasPrTemplates = (root: string) =>
	hasAnyFile(root, [".github/PULL_REQUEST_TEMPLATE.md", "PULL_REQUEST_TEMPLATE.md"]);

const hasProductAnalytics = (apps: AppInfo[]) =>
	hasAnyDependencyAcrossApps(apps, ["segment", "@segment/analytics-node", "amplitude", "mixpanel", "posthog-js", "posthog"]);

const hasNPlusOneDetectionForApp = (app: AppInfo) =>
	hasAnyDependency(app, ["nplusone", "bullet", "pghero", "django-silk"]);

const hasDuplicateCodeDetectionForApp = (app: AppInfo) => hasAnyDependency(app, ["jscpd", "sonarqube-scanner"]);

const hasModularizationEnforcementForApp = (app: AppInfo) =>
	hasAnyDependency(app, ["eslint-plugin-boundaries", "eslint-plugin-import", "dependency-cruiser"]);

const hasHeavyDependencyDetectionForApp = (app: AppInfo) =>
	hasAnyDependency(app, ["bundlewatch", "size-limit", "webpack-bundle-analyzer"]);

const hasUnusedDependenciesDetectionForApp = (app: AppInfo) => hasAnyDependency(app, ["depcheck", "knip"]);

const hasFeatureFlagInfraForApp = (app: AppInfo) =>
	hasAnyDependency(app, ["launchdarkly", "unleash", "configcat", "growthbook", "flagsmith"]);

const hasStructuredLoggingForApp = (app: AppInfo) => hasAnyDependency(app, ["pino", "winston", "bunyan", "loguru", "structlog"]);

const hasDistributedTracingForApp = (app: AppInfo) =>
	hasAnyDependency(app, ["@opentelemetry/api", "opentelemetry", "dd-trace", "newrelic"]);

const hasMetricsCollectionForApp = (app: AppInfo) =>
	hasAnyDependency(app, ["prom-client", "opentelemetry", "statsd", "dd-trace"]);

const hasErrorTrackingForApp = (app: AppInfo) => hasAnyDependency(app, ["@sentry/node", "@sentry/react", "bugsnag", "rollbar"]);

const hasCircuitBreakersForApp = (app: AppInfo) => hasAnyDependency(app, ["opossum", "cockatiel", "resilience4j"]);

const hasProfilingInstrumentationForApp = (app: AppInfo) => hasAnyDependency(app, ["clinic", "pprof", "py-spy"]);

const hasSensitiveDataScrubbingForApp = (app: AppInfo) => hasAnyDependency(app, ["@sentry/node", "pino", "winston"]);

const hasSecretsManagementForApp = (app: AppInfo) =>
	hasAnyDependency(app, ["@aws-sdk/client-secrets-manager", "vault", "doppler"]);

const hasProductAnalyticsForApp = (app: AppInfo) =>
	hasAnyDependency(app, ["segment", "@segment/analytics-node", "amplitude", "mixpanel", "posthog-js", "posthog"]);

const buildCriteria = (): Criterion[] => [
	// Style & Validation
	{
		id: "naming-consistency",
		category: "Style & Validation",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Naming Consistency",
		description: "Lint rules enforce naming conventions.",
		recommendation: "Add lint rules for naming conventions.",
		scope: "app",
		checkApp: (app, repo) => (hasNamingConsistency(repo.root, app) ? passResult("Naming rules configured") : failResult("No naming rules")),
	},
	{
		id: "dead-code-detection",
		category: "Style & Validation",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Dead Code Detection",
		description: "Tooling detects dead/unused code.",
		recommendation: "Add dead code detection tooling (depcheck/knip/etc.).",
		scope: "app",
		checkApp: (app) => (hasDeadCodeDetection(app) ? passResult("Dead code tooling detected") : failResult("No dead code tooling")),
	},
	{
		id: "technical-debt-tracking",
		category: "Style & Validation",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Technical Debt Tracking",
		description: "Code quality tooling tracks technical debt.",
		recommendation: "Add SonarQube/Code Climate or similar tooling.",
		scope: "repo",
		checkRepo: (repo) => (hasTechDebtTracking(repo.root) ? passResult("Tech debt tooling configured") : failResult("No tech debt tooling")),
	},
	{
		id: "n-plus-one-query-detection",
		category: "Style & Validation",
		tier: "ADVANCED",
		level: tierToLevel.ADVANCED,
		title: "N+1 Query Detection",
		description: "Tooling detects N+1 query patterns.",
		recommendation: "Add N+1 detection tooling (nplusone, bullet, django-silk).",
		scope: "app",
		checkApp: (app) =>
			app.type !== "service"
				? naResult("Not a service app")
				: hasNPlusOneDetectionForApp(app)
					? passResult("N+1 detection tooling configured")
					: failResult("No N+1 detection tooling"),
	},
	{
		id: "cyclomatic-complexity",
		category: "Style & Validation",
		tier: "ADVANCED",
		level: tierToLevel.ADVANCED,
		title: "Cyclomatic Complexity",
		description: "Lint rules enforce complexity thresholds.",
		recommendation: "Enable cyclomatic complexity lint rules.",
		scope: "repo",
		checkRepo: (repo) => (hasCyclomaticComplexity(repo.root) ? passResult("Complexity rules configured") : failResult("No complexity rules")),
	},
	{
		id: "duplicate-code-detection",
		category: "Style & Validation",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Duplicate Code Detection",
		description: "Tooling detects duplicated code patterns.",
		recommendation: "Add duplication detection tooling (jscpd, SonarQube).",
		scope: "app",
		checkApp: (app) =>
			hasDuplicateCodeDetectionForApp(app) ? passResult("Duplicate code tooling configured") : failResult("No duplicate code tooling"),
	},
	{
		id: "code-modularization-enforcement",
		category: "Style & Validation",
		tier: "ADVANCED",
		level: tierToLevel.ADVANCED,
		title: "Code Modularization Enforcement",
		description: "Rules enforce module boundaries.",
		recommendation: "Add module boundary tooling (boundaries/import rules/dependency-cruiser).",
		scope: "app",
		checkApp: (app) =>
			hasModularizationEnforcementForApp(app) ? passResult("Boundary tooling configured") : failResult("No modularization tooling"),
	},
	{
		id: "linter-configuration",
		category: "Style & Validation",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Linter Configuration",
		description: "Lint configuration exists.",
		recommendation: "Add ESLint/Ruff or similar linting configuration.",
		scope: "app",
		checkApp: (app, repo) =>
			hasLintConfig(app.path, app) || hasLintConfig(repo.root, app)
				? passResult("Lint config found")
				: failResult("No lint config"),
	},
	{
		id: "type-checker",
		category: "Style & Validation",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Type Checker",
		description: "Type checking configuration exists.",
		recommendation: "Add tsconfig, mypy, or pyright configuration.",
		scope: "app",
		checkApp: (app, repo) =>
			hasTypeCheckConfig(app.path, app) || hasTypeCheckConfig(repo.root, app)
				? passResult("Type checking configured")
				: failResult("No type checking config"),
	},
	{
		id: "code-formatter",
		category: "Style & Validation",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Code Formatter",
		description: "Formatter configuration exists.",
		recommendation: "Add Prettier/formatter configuration.",
		scope: "app",
		checkApp: (app, repo) =>
			hasCodeFormatter(repo.root, app) ? passResult("Formatter configured") : failResult("No formatter config"),
	},
	{
		id: "pre-commit-hooks",
		category: "Style & Validation",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Pre-commit Hooks",
		description: "Pre-commit hooks enforce checks locally.",
		recommendation: "Add Husky/lint-staged or pre-commit hooks.",
		scope: "app",
		checkApp: (_app, repo) =>
			hasPreCommitHooks(repo.root) ? passResult("Pre-commit hooks configured") : failResult("No pre-commit hooks"),
	},
	{
		id: "strict-typing",
		category: "Style & Validation",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Strict Typing",
		description: "Strict typing is enabled.",
		recommendation: "Enable strict typing settings.",
		scope: "app",
		checkApp: (app, repo) =>
			hasStrictTyping(repo.root, app) ? passResult("Strict typing enabled") : failResult("Strict typing not enabled"),
	},
	{
		id: "large-file-detection",
		category: "Style & Validation",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Large File Detection",
		description: "Large file detection tooling exists.",
		recommendation: "Enable Git LFS or large file detection.",
		scope: "repo",
		checkRepo: (repo) => (hasLargeFileDetection(repo.root) ? passResult("Large file detection configured") : failResult("No large file detection")),
	},
	// Build System
	{
		id: "automated-pr-review-generation",
		category: "Build System",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Automated PR Review Generation",
		description: "Automated PR review tooling is configured.",
		recommendation: "Add automated PR review tooling (reviewdog, AI review).",
		scope: "repo",
		checkRepo: (repo) =>
			repo.workflows.length === 0
				? failResult("No workflows")
				: hasAutomatedPrReview(repo.workflows)
					? passResult("PR review automation configured")
					: failResult("No PR review automation"),
	},
	{
		id: "deployment-frequency",
		category: "Build System",
		tier: "ADVANCED",
		level: tierToLevel.ADVANCED,
		title: "Deployment Frequency",
		description: "Deploy workflows exist for frequent releases.",
		recommendation: "Add deployment workflows for frequent releases.",
		scope: "repo",
		checkRepo: (repo) =>
			repo.workflows.length === 0
				? naResult("No workflows")
				: hasDeploymentFrequency(repo.workflows)
					? passResult("Deployment workflows found")
					: failResult("No deployment workflows"),
	},
	{
		id: "feature-flag-infrastructure",
		category: "Build System",
		tier: "ADVANCED",
		level: tierToLevel.ADVANCED,
		title: "Feature Flag Infrastructure",
		description: "Feature flag system is configured.",
		recommendation: "Add feature flag tooling (LaunchDarkly, Unleash, ConfigCat).",
		scope: "app",
		checkApp: (app) =>
			hasFeatureFlagInfraForApp(app) ? passResult("Feature flag tooling configured") : failResult("No feature flag tooling"),
	},
	{
		id: "monorepo-tooling",
		category: "Build System",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Monorepo Tooling",
		description: "Monorepo tooling is configured.",
		recommendation: "Add monorepo tooling (Nx, Turborepo, pnpm workspaces).",
		scope: "repo",
		checkRepo: (repo) =>
			hasMonorepoTooling(repo.root, repo.apps) ? passResult("Monorepo tooling detected") : failResult("No monorepo tooling"),
	},
	{
		id: "version-drift-detection",
		category: "Build System",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Version Drift Detection",
		description: "Tooling detects dependency version drift.",
		recommendation: "Add version drift detection (syncpack/changesets).",
		scope: "repo",
		checkRepo: (repo) =>
			hasVersionDriftDetection(repo.root) ? passResult("Version drift tooling configured") : failResult("No version drift tooling"),
	},
	{
		id: "heavy-dependency-detection",
		category: "Build System",
		tier: "ADVANCED",
		level: tierToLevel.ADVANCED,
		title: "Heavy Dependency Detection",
		description: "Tooling detects heavy dependencies.",
		recommendation: "Add bundle size monitoring (size-limit, bundlewatch).",
		scope: "app",
		checkApp: (app) =>
			hasHeavyDependencyDetectionForApp(app) ? passResult("Heavy dependency tooling detected") : failResult("No heavy dependency tooling"),
	},
	{
		id: "build-command-documentation",
		category: "Build System",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Build Command Documentation",
		description: "Build commands are documented.",
		recommendation: "Document build commands in README.",
		scope: "repo",
		checkRepo: (repo) =>
			hasBuildCommandDocumentation(repo.readme) ? passResult("Build commands documented") : failResult("No build documentation"),
	},
	{
		id: "dependencies-pinned",
		category: "Build System",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Dependencies Pinned",
		description: "Lockfiles are present.",
		recommendation: "Add dependency lockfiles.",
		scope: "repo",
		checkRepo: (repo) =>
			hasDependenciesPinned(repo.root) ? passResult("Lockfiles present") : failResult("No lockfiles"),
	},
	{
		id: "vcs-cli-tools",
		category: "Build System",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "VCS CLI Tools",
		description: "VCS tooling is referenced in docs.",
		recommendation: "Document VCS CLI tools usage.",
		scope: "repo",
		checkRepo: (repo) =>
			hasVcsCliTools(repo.root) ? passResult("VCS tooling referenced") : failResult("No VCS tooling references"),
	},
	{
		id: "agentic-development",
		category: "Build System",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Agentic Development",
		description: "Agentic development tooling is configured.",
		recommendation: "Add AGENTS.md or agent configuration.",
		scope: "repo",
		checkRepo: (repo) =>
			hasAgenticDevelopment(repo.root) ? passResult("Agentic dev config found") : failResult("No agentic dev config"),
	},
	{
		id: "single-command-setup",
		category: "Build System",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Single Command Setup",
		description: "A single command sets up the repo.",
		recommendation: "Add a setup/bootstrap script.",
		scope: "repo",
		checkRepo: (repo) =>
			hasSingleCommandSetup(repo.apps) ? passResult("Setup script found") : failResult("No setup script"),
	},
	{
		id: "release-notes-automation",
		category: "Build System",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Release Notes Automation",
		description: "Release notes generation is automated.",
		recommendation: "Add release notes automation (Changesets, Release Please).",
		scope: "repo",
		checkRepo: (repo) =>
			hasReleaseNotesAutomation(repo.root) ? passResult("Release notes automation configured") : failResult("No release notes automation"),
	},
	{
		id: "unused-dependencies-detection",
		category: "Build System",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Unused Dependencies Detection",
		description: "Tooling detects unused dependencies.",
		recommendation: "Add unused dependency tooling (depcheck/knip).",
		scope: "app",
		checkApp: (app) =>
			hasUnusedDependenciesDetectionForApp(app)
				? passResult("Unused dependency tooling configured")
				: failResult("No unused dependency tooling"),
	},
	{
		id: "release-automation",
		category: "Build System",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Release Automation",
		description: "Automated releases are configured.",
		recommendation: "Add release automation (Changesets/semantic-release).",
		scope: "repo",
		checkRepo: (repo) =>
			hasReleaseAutomation(repo.root) ? passResult("Release automation configured") : failResult("No release automation"),
	},
	{
		id: "fast-ci-feedback",
		category: "Build System",
		tier: "ADVANCED",
		level: tierToLevel.ADVANCED,
		title: "Fast CI Feedback",
		description: "CI feedback is optimized for speed.",
		recommendation: "Add caching/matrix/parallel CI workflows.",
		scope: "repo",
		checkRepo: (repo) =>
			repo.workflows.length === 0
				? naResult("No workflows")
				: hasFastCiFeedback(repo.workflows)
					? passResult("Fast CI techniques detected")
					: failResult("No fast CI optimization"),
	},
	{
		id: "build-performance-tracking",
		category: "Build System",
		tier: "ADVANCED",
		level: tierToLevel.ADVANCED,
		title: "Build Performance Tracking",
		description: "Build performance tracking is configured.",
		recommendation: "Add build performance tracking in CI.",
		scope: "repo",
		checkRepo: (repo) =>
			repo.workflows.length === 0
				? naResult("No workflows")
				: hasBuildPerfTracking(repo.workflows)
					? passResult("Build performance tracking detected")
					: failResult("No build performance tracking"),
	},
	{
		id: "progressive-rollout",
		category: "Build System",
		tier: "ADVANCED",
		level: tierToLevel.ADVANCED,
		title: "Progressive Rollout",
		description: "Progressive rollout mechanisms exist.",
		recommendation: "Add progressive rollout tooling.",
		scope: "repo",
		checkRepo: (repo) =>
			repo.workflows.length === 0
				? naResult("No workflows")
				: hasProgressiveRollout(repo.workflows)
					? passResult("Progressive rollout configured")
					: failResult("No progressive rollout"),
	},
	{
		id: "rollback-automation",
		category: "Build System",
		tier: "ADVANCED",
		level: tierToLevel.ADVANCED,
		title: "Rollback Automation",
		description: "Automated rollback mechanisms exist.",
		recommendation: "Add rollback automation tooling.",
		scope: "repo",
		checkRepo: (repo) =>
			repo.workflows.length === 0
				? naResult("No workflows")
				: hasRollbackAutomation(repo.workflows)
					? passResult("Rollback automation detected")
					: failResult("No rollback automation"),
	},
	{
		id: "dead-feature-flag-detection",
		category: "Build System",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Dead Feature Flag Detection",
		description: "Tooling detects stale feature flags.",
		recommendation: "Add dead feature flag detection.",
		scope: "repo",
		checkRepo: (repo) =>
			hasAnyDependencyAcrossApps(repo.apps, ["launchdarkly", "unleash", "configcat", "growthbook", "flagsmith"])
				? hasDeadFeatureFlagDetection(repo.apps)
					? passResult("Dead feature flag detection configured")
					: failResult("No dead flag detection")
				: naResult("No feature flag tooling"),
	},
	// Testing
	{
		id: "test-performance-tracking",
		category: "Testing",
		tier: "ADVANCED",
		level: tierToLevel.ADVANCED,
		title: "Test Performance Tracking",
		description: "Test performance is tracked.",
		recommendation: "Add test performance tracking tooling.",
		scope: "app",
		checkApp: (app) =>
			hasTestPerformanceTracking([app]) ? passResult("Test performance tooling detected") : failResult("No test performance tracking"),
	},
	{
		id: "test-coverage-thresholds",
		category: "Testing",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Test Coverage Thresholds",
		description: "Coverage thresholds are configured.",
		recommendation: "Add coverage thresholds in test config.",
		scope: "app",
		checkApp: (_app, repo) =>
			hasTestCoverageThresholds(repo.root) ? passResult("Coverage thresholds configured") : failResult("No coverage thresholds"),
	},
	{
		id: "test-isolation",
		category: "Testing",
		tier: "ADVANCED",
		level: tierToLevel.ADVANCED,
		title: "Test Isolation",
		description: "Tests are isolated from external systems.",
		recommendation: "Add test isolation tooling (testcontainers, mocks).",
		scope: "app",
		checkApp: (app) =>
			hasTestIsolation([app]) ? passResult("Test isolation tooling detected") : failResult("No test isolation tooling"),
	},
	{
		id: "integration-tests-exist",
		category: "Testing",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Integration Tests Exist",
		description: "Integration tests exist.",
		recommendation: "Add integration tests.",
		scope: "app",
		checkApp: (app, repo) =>
			hasIntegrationTests(repo.root, app) ? passResult("Integration tests detected") : failResult("No integration tests"),
	},
	{
		id: "flaky-test-detection",
		category: "Testing",
		tier: "ADVANCED",
		level: tierToLevel.ADVANCED,
		title: "Flaky Test Detection",
		description: "Tooling detects flaky tests.",
		recommendation: "Add flaky test detection tooling.",
		scope: "app",
		checkApp: (app) =>
			hasFlakyTestDetection([app]) ? passResult("Flaky test tooling detected") : failResult("No flaky test tooling"),
	},
	{
		id: "unit-tests-exist",
		category: "Testing",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Unit Tests Exist",
		description: "Unit tests exist.",
		recommendation: "Add unit tests.",
		scope: "app",
		checkApp: (app) => (hasTestFiles(app.path) ? passResult("Unit test files found") : failResult("No unit tests")),
	},
	{
		id: "unit-tests-runnable",
		category: "Testing",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Unit Tests Runnable",
		description: "Unit tests are runnable via script.",
		recommendation: "Add a test script.",
		scope: "app",
		checkApp: (app) =>
			(app.scripts ?? {}).test ? passResult("Test script found") : failResult("No test script"),
	},
	{
		id: "test-file-naming-conventions",
		category: "Testing",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Test File Naming Conventions",
		description: "Test files use consistent naming conventions.",
		recommendation: "Standardize test file naming (test/spec).",
		scope: "app",
		checkApp: (app) =>
			hasTestFileNaming(app.path) ? passResult("Test file naming conventions detected") : failResult("No test naming convention"),
	},
	// Documentation
	{
		id: "skills-configuration",
		category: "Documentation",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Skills Configuration",
		description: "Skills are configured for agents.",
		recommendation: "Add skills configuration under .pi/skills or .claude/skills.",
		scope: "repo",
		checkRepo: (repo) => (hasSkillsConfig(repo.root) ? passResult("Skills configuration found") : failResult("No skills configuration")),
	},
	{
		id: "api-schema-docs",
		category: "Documentation",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "API Schema Docs",
		description: "API schemas are documented.",
		recommendation: "Add OpenAPI/GraphQL schema documentation.",
		scope: "app",
		checkApp: (app, repo) =>
			app.type !== "service"
				? naResult("Not a service app")
				: hasAnyFileInPaths([repo.root, app.path], ["openapi.yaml", "openapi.yml", "swagger.json", "schema.graphql", "api.md"])
					? passResult("API schema docs found")
					: failResult("No API schema docs"),
	},
	{
		id: "agents-md-freshness-validation",
		category: "Documentation",
		tier: "ADVANCED",
		level: tierToLevel.ADVANCED,
		title: "AGENTS.md Freshness Validation",
		description: "AGENTS.md freshness is validated in CI.",
		recommendation: "Add CI check for AGENTS.md freshness.",
		scope: "repo",
		checkRepo: (repo) =>
			fileExists(path.join(repo.root, "AGENTS.md"))
				? hasAgentsFreshnessValidation(repo.workflows)
					? passResult("AGENTS.md validation configured")
					: failResult("No AGENTS.md validation")
				: naResult("AGENTS.md missing"),
	},
	{
		id: "agents-md-file",
		category: "Documentation",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "AGENTS.md File",
		description: "AGENTS.md exists.",
		recommendation: "Add AGENTS.md documentation.",
		scope: "repo",
		checkRepo: (repo) =>
			fileExists(path.join(repo.root, "AGENTS.md")) ? passResult("AGENTS.md found") : failResult("AGENTS.md missing"),
	},
	{
		id: "readme-file",
		category: "Documentation",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "README File",
		description: "README exists.",
		recommendation: "Add a README.",
		scope: "repo",
		checkRepo: (repo) =>
			fileExists(path.join(repo.root, "README.md")) ? passResult("README found") : failResult("README missing"),
	},
	{
		id: "automated-documentation-generation",
		category: "Documentation",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Automated Documentation Generation",
		description: "Documentation generation is automated.",
		recommendation: "Add automated docs generation tooling.",
		scope: "repo",
		checkRepo: (repo) =>
			hasAutoDocsGeneration(repo.apps) ? passResult("Automated docs tooling detected") : failResult("No auto docs tooling"),
	},
	{
		id: "documentation-freshness",
		category: "Documentation",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Documentation Freshness",
		description: "Docs are kept up to date.",
		recommendation: "Update docs regularly.",
		scope: "repo",
		checkRepo: (repo) =>
			hasDocumentationFreshness(repo.root) ? passResult("Docs updated recently") : failResult("Docs appear stale"),
	},
	{
		id: "service-architecture-documented",
		category: "Documentation",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Service Architecture Documented",
		description: "Architecture is documented.",
		recommendation: "Document service architecture.",
		scope: "repo",
		checkRepo: (repo) =>
			hasServiceArchitectureDoc(repo.root) ? passResult("Architecture docs found") : failResult("No architecture docs"),
	},
	// Development Environment
	{
		id: "dev-container",
		category: "Development Environment",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Dev Container",
		description: "Dev container configuration exists.",
		recommendation: "Add a devcontainer configuration.",
		scope: "repo",
		checkRepo: (repo) => (hasDevContainer(repo.root) ? passResult("Devcontainer config found") : failResult("No devcontainer")),
	},
	{
		id: "database-schema",
		category: "Development Environment",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Database Schema",
		description: "Database schema is defined.",
		recommendation: "Add database schema/migrations.",
		scope: "app",
		checkApp: (app, repo) =>
			app.type !== "service"
				? naResult("Not a service app")
				: hasAnyFileInPaths([repo.root, app.path], ["schema.prisma", "schema.sql", "dbschema.json", "migrations"])
					? passResult("Database schema found")
					: failResult("No database schema"),
	},
	{
		id: "environment-template",
		category: "Development Environment",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Environment Template",
		description: "Environment template exists.",
		recommendation: "Add .env.example or environment template.",
		scope: "repo",
		checkRepo: (repo) => (hasEnvTemplate(repo.root) ? passResult("Env template found") : failResult("No env template")),
	},
	{
		id: "local-services-setup",
		category: "Development Environment",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Local Services Setup",
		description: "Local services setup exists.",
		recommendation: "Add docker-compose or local services setup.",
		scope: "repo",
		checkRepo: (repo) =>
			hasLocalServicesSetup(repo.root) ? passResult("Local services setup found") : failResult("No local services setup"),
	},
	{
		id: "devcontainer-runnable",
		category: "Development Environment",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Devcontainer Runnable",
		description: "Devcontainer is runnable.",
		recommendation: "Ensure devcontainer builds successfully.",
		scope: "repo",
		checkRepo: (repo) =>
			!hasDevContainer(repo.root)
				? naResult("No devcontainer")
				: passResult("Devcontainer config present"),
	},
	// Debugging & Observability
	{
		id: "structured-logging",
		category: "Debugging & Observability",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Structured Logging",
		description: "Structured logging libraries are used.",
		recommendation: "Add structured logging (pino, winston, etc.).",
		scope: "app",
		checkApp: (app) =>
			app.type !== "service"
				? naResult("Not a service app")
				: hasStructuredLoggingForApp(app)
					? passResult("Structured logging detected")
					: failResult("No structured logging"),
	},
	{
		id: "distributed-tracing",
		category: "Debugging & Observability",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Distributed Tracing",
		description: "Distributed tracing is configured.",
		recommendation: "Add tracing instrumentation (OpenTelemetry, Datadog).",
		scope: "app",
		checkApp: (app) =>
			app.type !== "service"
				? naResult("Not a service app")
				: hasDistributedTracingForApp(app)
					? passResult("Tracing instrumentation detected")
					: failResult("No tracing instrumentation"),
	},
	{
		id: "code-quality-metrics-dashboard",
		category: "Debugging & Observability",
		tier: "ADVANCED",
		level: tierToLevel.ADVANCED,
		title: "Code Quality Metrics Dashboard",
		description: "Code quality metrics dashboard exists.",
		recommendation: "Add SonarQube/Code Climate dashboard.",
		scope: "repo",
		checkRepo: (repo) =>
			hasCodeQualityDashboard(repo.root) ? passResult("Code quality dashboard configured") : failResult("No code quality dashboard"),
	},
	{
		id: "error-tracking-contextualized",
		category: "Debugging & Observability",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Error Tracking Contextualized",
		description: "Error tracking is configured.",
		recommendation: "Add error tracking (Sentry, Bugsnag).",
		scope: "app",
		checkApp: (app) =>
			app.type === "library"
				? naResult("Library app")
				: hasErrorTrackingForApp(app)
					? passResult("Error tracking configured")
					: failResult("No error tracking"),
	},
	{
		id: "alerting-configured",
		category: "Debugging & Observability",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Alerting Configured",
		description: "Alerting is configured.",
		recommendation: "Add alerting configuration.",
		scope: "repo",
		checkRepo: (repo) =>
			hasAlertingConfigured(repo.root) ? passResult("Alerting configured") : failResult("No alerting config"),
	},
	{
		id: "runbooks-documented",
		category: "Debugging & Observability",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Runbooks Documented",
		description: "Runbooks are documented.",
		recommendation: "Add runbooks for incidents.",
		scope: "repo",
		checkRepo: (repo) =>
			hasRunbooks(repo.root) ? passResult("Runbooks documented") : failResult("No runbooks"),
	},
	{
		id: "metrics-collection",
		category: "Debugging & Observability",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Metrics Collection",
		description: "Metrics collection is configured.",
		recommendation: "Add metrics collection (Prometheus, OpenTelemetry).",
		scope: "app",
		checkApp: (app) =>
			app.type !== "service"
				? naResult("Not a service app")
				: hasMetricsCollectionForApp(app)
					? passResult("Metrics collection configured")
					: failResult("No metrics collection"),
	},
	{
		id: "deployment-observability",
		category: "Debugging & Observability",
		tier: "ADVANCED",
		level: tierToLevel.ADVANCED,
		title: "Deployment Observability",
		description: "Deployments emit observability signals.",
		recommendation: "Integrate deployments with observability tools.",
		scope: "repo",
		checkRepo: (repo) =>
			repo.workflows.length === 0
				? naResult("No workflows")
				: hasDeploymentObservability(repo.workflows)
					? passResult("Deployment observability configured")
					: failResult("No deployment observability"),
	},
	{
		id: "health-checks",
		category: "Debugging & Observability",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Health Checks",
		description: "Health checks are implemented.",
		recommendation: "Add health check endpoints.",
		scope: "app",
		checkApp: (app) =>
			app.type !== "service"
				? naResult("Not a service app")
				: hasMatchingFile(app.path, /(health|status).*\.(js|ts|py|go|rb)/i)
					? passResult("Health checks detected")
					: failResult("No health checks"),
	},
	{
		id: "circuit-breakers",
		category: "Debugging & Observability",
		tier: "ADVANCED",
		level: tierToLevel.ADVANCED,
		title: "Circuit Breakers",
		description: "Circuit breaker patterns are implemented.",
		recommendation: "Add circuit breaker tooling.",
		scope: "app",
		checkApp: (app) =>
			app.type !== "service"
				? naResult("Not a service app")
				: hasCircuitBreakersForApp(app)
					? passResult("Circuit breaker tooling detected")
					: failResult("No circuit breaker tooling"),
	},
	{
		id: "profiling-instrumentation",
		category: "Debugging & Observability",
		tier: "ADVANCED",
		level: tierToLevel.ADVANCED,
		title: "Profiling Instrumentation",
		description: "Profiling instrumentation exists.",
		recommendation: "Add profiling tooling (clinic, pprof, py-spy).",
		scope: "app",
		checkApp: (app) =>
			app.type !== "service"
				? naResult("Not a service app")
				: hasProfilingInstrumentationForApp(app)
					? passResult("Profiling tooling detected")
					: failResult("No profiling tooling"),
	},
	// Security
	{
		id: "branch-protection",
		category: "Security",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Branch Protection",
		description: "Branch protection is configured.",
		recommendation: "Configure branch protection rules.",
		scope: "repo",
		checkRepo: (repo) =>
			hasBranchProtection(repo.root) ? passResult("Branch protection configured") : failResult("No branch protection"),
	},
	{
		id: "secret-scanning",
		category: "Security",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Secret Scanning",
		description: "Secret scanning tooling exists.",
		recommendation: "Add secret scanning (gitleaks, trivy).",
		scope: "repo",
		checkRepo: (repo) =>
			hasSecretScanning(repo.root) ? passResult("Secret scanning configured") : failResult("No secret scanning"),
	},
	{
		id: "codeowners-file",
		category: "Security",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "CODEOWNERS File",
		description: "CODEOWNERS file exists.",
		recommendation: "Add CODEOWNERS.",
		scope: "repo",
		checkRepo: (repo) =>
			hasCodeowners(repo.root) ? passResult("CODEOWNERS found") : failResult("CODEOWNERS missing"),
	},
	{
		id: "automated-security-review-generation",
		category: "Security",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Automated Security Review Generation",
		description: "Security reviews are automated in CI.",
		recommendation: "Add CodeQL or security review workflows.",
		scope: "repo",
		checkRepo: (repo) =>
			repo.workflows.length === 0
				? failResult("No workflows")
				: hasAutomatedSecurityReview(repo.workflows)
					? passResult("Security review automation configured")
					: failResult("No security review automation"),
	},
	{
		id: "dependency-update-automation",
		category: "Security",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Dependency Update Automation",
		description: "Dependency update automation is configured.",
		recommendation: "Enable Dependabot or Renovate.",
		scope: "repo",
		checkRepo: (repo) =>
			hasDependencyAutomation(repo.root) ? passResult("Dependency automation configured") : failResult("No dependency automation"),
	},
	{
		id: "sensitive-data-log-scrubbing",
		category: "Security",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Sensitive Data Log Scrubbing",
		description: "Sensitive data is scrubbed from logs.",
		recommendation: "Add log scrubbing or redaction tooling.",
		scope: "app",
		checkApp: (app) =>
			app.type !== "service"
				? naResult("Not a service app")
				: hasSensitiveDataScrubbingForApp(app)
					? passResult("Log scrubbing configured")
					: failResult("No log scrubbing"),
	},
	{
		id: "gitignore-comprehensive",
		category: "Security",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Gitignore Comprehensive",
		description: "Gitignore file exists.",
		recommendation: "Add .gitignore.",
		scope: "repo",
		checkRepo: (repo) =>
			hasGitignoreComprehensive(repo.root) ? passResult(".gitignore found") : failResult("No .gitignore"),
	},
	{
		id: "secrets-management",
		category: "Security",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Secrets Management",
		description: "Secrets management tooling exists.",
		recommendation: "Add secrets management tooling (Vault, AWS Secrets Manager).",
		scope: "app",
		checkApp: (app) =>
			hasSecretsManagementForApp(app) ? passResult("Secrets management tooling detected") : failResult("No secrets management"),
	},
	{
		id: "dast-scanning",
		category: "Security",
		tier: "ADVANCED",
		level: tierToLevel.ADVANCED,
		title: "DAST Scanning",
		description: "DAST scanning is configured.",
		recommendation: "Add DAST scanning in CI.",
		scope: "repo",
		checkRepo: (repo) =>
			repo.workflows.length === 0
				? naResult("No workflows")
				: hasDastScanning(repo.workflows)
					? passResult("DAST scanning configured")
					: failResult("No DAST scanning"),
	},
	{
		id: "pii-handling",
		category: "Security",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "PII Handling",
		description: "PII handling guidelines exist.",
		recommendation: "Add PII handling documentation.",
		scope: "repo",
		checkRepo: (repo) =>
			hasPiiHandling(repo.root) ? passResult("PII handling docs found") : naResult("No PII handling docs"),
	},
	{
		id: "privacy-compliance",
		category: "Security",
		tier: "ADVANCED",
		level: tierToLevel.ADVANCED,
		title: "Privacy Compliance",
		description: "Privacy compliance documentation exists.",
		recommendation: "Add privacy compliance documentation.",
		scope: "repo",
		checkRepo: (repo) =>
			hasPrivacyCompliance(repo.root) ? passResult("Privacy compliance docs found") : naResult("No privacy compliance docs"),
	},
	// Task Discovery
	{
		id: "issue-templates",
		category: "Task Discovery",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Issue Templates",
		description: "Issue templates exist.",
		recommendation: "Add issue templates.",
		scope: "repo",
		checkRepo: (repo) =>
			hasIssueTemplates(repo.root) ? passResult("Issue templates found") : failResult("No issue templates"),
	},
	{
		id: "issue-labeling-system",
		category: "Task Discovery",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "Issue Labeling System",
		description: "Issue labeling system exists.",
		recommendation: "Add issue labels configuration.",
		scope: "repo",
		checkRepo: (repo) =>
			hasIssueLabelingSystem(repo.root) ? passResult("Issue labels configured") : failResult("No issue labels"),
	},
	{
		id: "pr-templates",
		category: "Task Discovery",
		tier: "BASIC",
		level: tierToLevel.BASIC,
		title: "PR Templates",
		description: "Pull request templates exist.",
		recommendation: "Add PR templates.",
		scope: "repo",
		checkRepo: (repo) =>
			hasPrTemplates(repo.root) ? passResult("PR templates found") : failResult("No PR templates"),
	},
	{
		id: "backlog-health",
		category: "Task Discovery",
		tier: "ADVANCED",
		level: tierToLevel.ADVANCED,
		title: "Backlog Health",
		description: "Backlog health is monitored.",
		recommendation: "Add backlog health tracking.",
		scope: "repo",
		checkRepo: () => naResult("Backlog health not evaluated"),
	},
	// Product & Experimentation
	{
		id: "product-analytics-instrumentation",
		category: "Product & Experimentation",
		tier: "INTERMEDIATE",
		level: tierToLevel.INTERMEDIATE,
		title: "Product Analytics Instrumentation",
		description: "Product analytics tooling is configured.",
		recommendation: "Add product analytics instrumentation (Segment, Amplitude, PostHog).",
		scope: "app",
		checkApp: (app) =>
			app.type === "library"
				? naResult("Library app")
				: hasProductAnalyticsForApp(app)
					? passResult("Product analytics configured")
					: failResult("No product analytics"),
	},
];

const evaluateCriteria = (criteria: Criterion[], repo: RepoContext): CriterionResult[] => {
	const results: CriterionResult[] = [];
	for (const criterion of criteria) {
		if (criterion.scope === "repo" && criterion.checkRepo) {
			const result = criterion.checkRepo(repo);
			const applicable = result.status !== "na";
			results.push({
				id: criterion.id,
				category: criterion.category,
				tier: criterion.tier,
				level: criterion.level,
				title: criterion.title,
				description: criterion.description,
				recommendation: criterion.recommendation,
				scope: criterion.scope,
				numerator: result.status === "pass" ? 1 : 0,
				denominator: applicable ? 1 : 0,
				passed: result.status === "pass",
				applicable,
				reasons: [{ target: repo.repoName, status: result.status, details: result.details }],
			});
			continue;
		}

		if (criterion.scope === "app" && criterion.checkApp) {
			const reasons = repo.apps.map((app) => {
				const result = criterion.checkApp!(app, repo);
				return { target: app.relativePath, status: result.status, details: result.details };
			});
			const applicableReasons = reasons.filter((reason) => reason.status !== "na");
			const numerator = applicableReasons.filter((reason) => reason.status === "pass").length;
			const denominator = applicableReasons.length;
			results.push({
				id: criterion.id,
				category: criterion.category,
				tier: criterion.tier,
				level: criterion.level,
				title: criterion.title,
				description: criterion.description,
				recommendation: criterion.recommendation,
				scope: criterion.scope,
				numerator,
				denominator,
				passed: denominator > 0 ? numerator === denominator : false,
				applicable: denominator > 0,
				reasons,
			});
		}
	}
	return results;
};

const computeMaturity = (criteria: CriterionResult[]) => {
	const applicableCriteria = criteria.filter((item) => item.applicable);
	const criteriaTotal = applicableCriteria.length;
	const criteriaPassed = applicableCriteria.filter((item) => item.passed).length;
	const checksTotal = criteria.reduce((sum, item) => sum + item.denominator, 0);
	const checksPassed = criteria.reduce((sum, item) => sum + item.numerator, 0);
	const passRate = checksTotal ? checksPassed / checksTotal : 0;
	const score = Math.round(passRate * 100);

	const levelScores = [1, 2, 3, 4, 5].map((level) => {
		const items = criteria.filter((item) => item.level === level && item.applicable);
		const total = items.length;
		const passed = items.filter((item) => item.passed).length;
		return { level, passed, total, passRate: total ? passed / total : 0 };
	});

	let levelAchieved = 0;
	for (const level of [1, 2, 3, 4, 5]) {
		const items = criteria.filter((item) => item.level === level && item.applicable);
		if (items.length === 0) continue;
		if (items.every((item) => item.passed)) {
			levelAchieved = level;
		} else {
			break;
		}
	}

	return {
		levelAchieved: levelAchieved || 1,
		score,
		passRate,
		criteriaPassed,
		criteriaTotal,
		checksPassed,
		checksTotal,
		levelScores,
	};
};

const buildActionItems = (criteria: CriterionResult[]) => {
	return criteria
		.filter((item) => item.applicable && !item.passed)
		.sort((a, b) => b.level - a.level)
		.slice(0, 3)
		.map((item) => ({
			title: item.title,
			recommendation: item.recommendation,
			level: item.level,
		}));
};

const computeCategoryStats = (criteria: CriterionResult[]) => {
	const stats = new Map<string, { passed: number; total: number }>();
	for (const item of criteria) {
		const entry = stats.get(item.category) ?? { passed: 0, total: 0 };
		if (item.applicable) {
			entry.total += item.denominator;
			entry.passed += item.numerator;
		}
		stats.set(item.category, entry);
	}
	return Array.from(stats.entries()).map(([name, value]) => ({
		name,
		passed: value.passed,
		total: value.total,
		passRate: value.total ? value.passed / value.total : null,
	}));
};

const loadHistory = (repoRoot: string) => {
	const reportsRoot = path.join(repoRoot, ".pi", "reports");
	if (!fileExists(reportsRoot)) return [] as { generatedAt: string; level: number; score: number }[];
	const histories: { generatedAt: string; level: number; score: number }[] = [];
	for (const entry of listFiles(reportsRoot)) {
		if (!entry.isDirectory()) continue;
		const reportPath = path.join(reportsRoot, entry.name, "readiness-report.json");
		const data = readJson(reportPath);
		if (!data || typeof data !== "object") continue;
		const report = data as Report;
		if (!report.generatedAt || !report.maturity) continue;
		histories.push({
			generatedAt: report.generatedAt,
			level: report.maturity.levelAchieved,
			score: report.maturity.score,
		});
	}
	return histories.sort((a, b) => new Date(a.generatedAt).getTime() - new Date(b.generatedAt).getTime());
};

const renderLevelChart = (history: { generatedAt: string; level: number }[]) => {
	if (history.length === 0) return "";
	const width = 620;
	const height = 160;
	const padding = 24;
	const points = history.map((item, index) => {
		const x = padding + (index / Math.max(history.length - 1, 1)) * (width - padding * 2);
		const y = height - padding - ((item.level - 1) / 4) * (height - padding * 2);
		return `${x},${y}`;
	});
	return `
		<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Level over time">
			<rect x="0" y="0" width="${width}" height="${height}" fill="var(--surface-2)" rx="12" />
			<polyline fill="none" stroke="var(--accent-strong)" stroke-width="3" points="${points.join(" ")}" />
			${history
				.map((item, index) => {
					const x = padding + (index / Math.max(history.length - 1, 1)) * (width - padding * 2);
					const y = height - padding - ((item.level - 1) / 4) * (height - padding * 2);
					return `<circle cx="${x}" cy="${y}" r="4" fill="var(--accent)" />`;
				})
				.join("")}
		</svg>`;
};

const renderCategoryChart = (categories: { name: string; passRate: number | null }[]) => {
	if (categories.length === 0) return "";
	const width = 620;
	const height = 240;
	const padding = 32;
	const barWidth = (width - padding * 2) / categories.length;
	return `
		<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Pass rate by category">
			<rect x="0" y="0" width="${width}" height="${height}" fill="var(--surface-2)" rx="12" />
			${categories
				.map((category, index) => {
					const rate = category.passRate ?? 0;
					const barHeight = rate * (height - padding * 2);
					const x = padding + index * barWidth;
					const y = height - padding - barHeight;
					const labelY = height - 10;
					return `
						<rect x="${x + 6}" y="${y}" width="${barWidth - 12}" height="${barHeight}" rx="6" fill="var(--accent-strong)" opacity="0.6" />
						<text x="${x + barWidth / 2}" y="${labelY}" text-anchor="middle" fill="var(--muted)" font-size="10">${category.name}</text>
						<text x="${x + barWidth / 2}" y="${y - 6}" text-anchor="middle" fill="var(--text)" font-size="10">${
							category.passRate === null ? "N/A" : `${Math.round(rate * 100)}%`
						}</text>
					`;
				})
				.join("")}
		</svg>`;
};

const renderHtml = (report: Report) => {
	const levelLabels: Record<number, string> = {
		1: "Functional",
		2: "Documented",
		3: "Standardized",
		4: "Optimized",
		5: "Autonomous",
	};

	const criteriaRows = report.criteria
		.map((item) => {
			const status = item.applicable ? (item.passed ? "Passed" : "Needs Work") : "N/A";
			const statusClass = item.applicable ? (item.passed ? "ok" : "warn") : "na";
			const reasons = item.reasons
				.map((reason) => `<li><strong>${reason.target}</strong>: ${reason.details}</li>`)
				.join("");
			return `<tr>
				<td>${item.category}</td>
				<td><span class="badge-pill">${item.tier}</span></td>
				<td>${item.title}</td>
				<td>${formatScore(item.numerator, item.denominator)}</td>
				<td class="${statusClass}"><span class="badge-pill">${status}</span></td>
				<td><ul>${reasons}</ul></td>
			</tr>`;
		})
		.join("");

	const levelRows = report.maturity.levelScores
		.map((level) => {
			const percent = Math.round(level.passRate * 100);
			return `<tr>
				<td>${level.level} - ${levelLabels[level.level]}</td>
				<td>${level.passed}/${level.total}</td>
				<td>${percent}%</td>
			</tr>`;
		})
		.join("");

	const categoryRows = report.categories
		.map((category) => {
			const percent = category.passRate === null ? "N/A" : `${Math.round(category.passRate * 100)}%`;
			return `<tr>
				<td>${category.name}</td>
				<td>${category.passed}/${category.total}</td>
				<td>${percent}</td>
			</tr>`;
		})
		.join("");

	const levelChart = renderLevelChart(report.history.map((item) => ({ generatedAt: item.generatedAt, level: item.level })));
	const categoryChart = renderCategoryChart(report.categories.map((category) => ({
		name: category.name,
		passRate: category.passRate,
	})));

	const appsList = report.apps
		.map((app) => `<li><strong>${app.relativePath}</strong> (${app.type}) — ${app.description ?? "No description"}</li>`)
		.join("");

	const actionsList = report.actionItems
		.map((item) => `<li><strong>Level ${item.level}</strong> — ${item.title}: ${item.recommendation}</li>`)
		.join("");

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Readiness Report - ${report.repoName}</title>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
	<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;600;700&family=Geist+Mono:wght@400;600&display=swap" rel="stylesheet" />
	<style>
		:root {
			--bg: hsl(40, 30%, 97%);
			--surface: hsl(40, 25%, 95%);
			--surface-2: hsl(40, 22%, 92%);
			--text: hsl(30, 15%, 15%);
			--muted: hsl(30, 10%, 35%);
			--border: hsl(35, 15%, 85%);
			--accent: hsl(35, 20%, 88%);
			--accent-strong: hsl(30, 20%, 25%);
			--focus: hsl(30, 20%, 25%);
		}
		@media (prefers-color-scheme: dark) {
			:root {
				--bg: hsl(30, 5%, 10.5%);
				--surface: hsl(30, 5%, 12%);
				--surface-2: hsl(30, 5%, 14%);
				--text: hsl(40, 20%, 92%);
				--muted: hsl(35, 10%, 70%);
				--border: hsl(30, 5%, 20%);
				--accent: hsl(35, 20%, 88%);
				--accent-strong: hsl(35, 15%, 70%);
				--focus: hsl(35, 15%, 70%);
			}
		}
		* { box-sizing: border-box; }
		body {
			font-family: "Geist", system-ui, sans-serif;
			margin: 0;
			background: var(--bg);
			color: var(--text);
			font-size: 0.95rem;
			line-height: 1.6;
			transition: background 0.2s ease, color 0.2s ease;
			animation: fade-in 0.2s ease;
		}
		code, pre { font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
		pre { background: var(--surface-2); border: 1px solid var(--border); border-radius: 0.5rem; padding: 16px; overflow: auto; max-height: 360px; }
		a { color: var(--accent-strong); text-decoration: none; }
		a:hover { text-decoration: underline; }
		details { margin-bottom: 12px; border: 1px solid var(--border); border-radius: 0.5rem; padding: 12px; background: var(--surface-2); }
		summary { cursor: pointer; font-weight: 600; }
		.container { max-width: 1100px; margin: 0 auto; padding: 32px; }
		.card {
			background: var(--surface);
			padding: 24px;
			border-radius: 0.5rem;
			margin-bottom: 24px;
			border: 1px solid var(--border);
			box-shadow: 0 1px 2px rgba(0,0,0,0.08);
			animation: slide-up 0.3s ease;
		}
		.grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(240px,1fr)); gap: 16px; }
		.badge { display: inline-block; padding: 4px 12px; border-radius: 999px; background: var(--accent); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
		.progress { height: 12px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
		.progress span { display: block; height: 100%; background: var(--accent-strong); width: ${Math.round(
			report.maturity.passRate * 100,
		)}%; }
		table { width: 100%; border-collapse: collapse; }
		th, td { text-align: left; padding: 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
		th { background: var(--surface-2); }
		.ok, .warn { color: var(--text); font-weight: 600; }
		.na { color: var(--muted); font-weight: 600; }
		.badge-pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface-2); font-size: 12px; }
		ul { margin: 0; padding-left: 20px; }
		.note { color: var(--muted); font-size: 0.95rem; }
		footer { text-align: center; color: var(--muted); font-size: 0.85rem; padding: 24px 0; }
		::-webkit-scrollbar { height: 10px; width: 10px; }
		::-webkit-scrollbar-thumb { background: var(--border); border-radius: 999px; }
		::-webkit-scrollbar-track { background: transparent; }
		@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
		@keyframes slide-up { from { transform: translateY(6px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
		@keyframes pulse-soft { 0%, 100% { opacity: 0.65; } 50% { opacity: 1; } }
	</style>
</head>
<body>
	<div class="container">
		<div class="card">
			<span class="badge">Readiness Report</span>
			<h1>${report.repoName}</h1>
			<p>Generated ${report.generatedAt}${report.model ? ` • Model ${report.model.provider}/${report.model.id}` : ""}</p>
			<div class="grid">
				<div>
					<h3>Level Achieved</h3>
					<p><strong>${report.maturity.levelAchieved} - ${levelLabels[report.maturity.levelAchieved]}</strong></p>
				</div>
				<div>
					<h3>Score</h3>
					<p><strong>${report.maturity.score}%</strong> (${report.maturity.checksPassed}/${report.maturity.checksTotal} checks)</p>
					<div class="progress"><span></span></div>
				</div>
				<div>
					<h3>Apps</h3>
					<p>${report.apps.length}</p>
				</div>
				<div>
					<h3>Languages</h3>
					<p>${report.languages.length ? report.languages.join(", ") : "Unknown"}</p>
				</div>
			</div>
		</div>
		<div class="card">
			<h2>Understanding the Output</h2>
			<p class="note">Scores are reported as numerator/denominator where numerator is apps passing and denominator is apps evaluated. The report includes Level Achieved, Applications Discovered, Criteria Results, and Action Items.</p>
		</div>
		<div class="card">
			<h2>Action Items</h2>
			<ul>${actionsList || "<li>All criteria passed. Keep it up!</li>"}</ul>
		</div>
		<div class="card">
			<h2>Applications Discovered</h2>
			<ul>${appsList || "<li>No applications detected</li>"}</ul>
		</div>
		<div class="card">
			<h2>Level Analytics</h2>
			<table>
				<thead>
					<tr><th>Level</th><th>Criteria Passed</th><th>Pass Rate</th></tr>
				</thead>
				<tbody>${levelRows}</tbody>
			</table>
		</div>
		<div class="card">
			<h2>Pass Rate by Category</h2>
			${categoryChart}
			<table>
				<thead>
					<tr><th>Category</th><th>Passed</th><th>Pass Rate</th></tr>
				</thead>
				<tbody>${categoryRows}</tbody>
			</table>
		</div>
		<div class="card">
			<h2>AI Prompt (Repo Snapshot)</h2>
			<p class="note">This is the exact prompt sent to the model.</p>
			<pre>${report.aiPrompt ? report.aiPrompt.replace(/</g, "&lt;") : "No AI prompt generated."}</pre>
		</div>
		<div class="card">
			<h2>Level Over Time</h2>
			${levelChart || "<p class=\"note\">No historical reports yet.</p>"}
		</div>
		<div class="card">
			<h2>Criteria Results</h2>
			<p class="note">Expand each category to review the detailed checks.</p>
			${report.categories
				.map((category) => {
					const items = report.criteria.filter((item) => item.category === category.name);
					const rows = items
						.map((item) => {
							const status = item.applicable ? (item.passed ? "Passed" : "Needs Work") : "N/A";
							const statusClass = item.applicable ? (item.passed ? "ok" : "warn") : "na";
							const reasons = item.reasons
								.map((reason) => `<li><strong>${reason.target}</strong>: ${reason.details}</li>`)
								.join("");
							return `<tr>
								<td><span class=\"badge-pill\">${item.tier}</span></td>
								<td>${item.title}</td>
								<td>${formatScore(item.numerator, item.denominator)}</td>
								<td class=\"${statusClass}\"><span class=\"badge-pill\">${status}</span></td>
								<td><ul>${reasons}</ul></td>
							</tr>`;
						})
						.join("");
					const percent = category.passRate === null ? "N/A" : `${Math.round(category.passRate * 100)}%`;
					return `
						<details>
							<summary><strong>${category.name}</strong> — ${category.passed}/${category.total} (${percent})</summary>
							<table>
								<thead>
									<tr><th>Tier</th><th>Criterion</th><th>Score</th><th>Status</th><th>Details</th></tr>
								</thead>
								<tbody>${rows}</tbody>
							</table>
						</details>`;
				})
				.join("")}
		</div>
		<div class="card">
			<h2>Viewing Historical Reports</h2>
			<p class="note">Reports are saved to <code>.pi/reports</code>. You can track readiness over time by comparing generated files.</p>
		</div>
		<div class="card">
			<h2>Remediation (Coming Soon)</h2>
			<p class="note">Future versions will offer automated fixes for failing criteria directly from the command.</p>
		</div>
		<footer>Sybil Solutions</footer>
	</div>
</body>
</html>`;
};

const buildNarrativePrompt = (report: Report, repoSnapshot: string) => {
	const summary = {
		repo: report.repoName,
		level: report.maturity.levelAchieved,
		score: report.maturity.score,
		apps: report.apps.map((app) => ({ path: app.relativePath, type: app.type, description: app.description })),
		actionItems: report.actionItems,
		criteria: report.criteria.map((item) => ({
			category: item.category,
			tier: item.tier,
			title: item.title,
			score: `${item.numerator}/${item.denominator}`,
			status: item.applicable ? (item.passed ? "passed" : "needs work") : "n/a",
		})),
	};

	return [
		"You are reviewing a software repository for readiness.",
		"Provide a concise Markdown summary with sections: Executive Summary, Strengths, Gaps, Next Actions.",
		"Use only the data provided. Do not invent tooling or files.",
		"Repository snapshot:",
		repoSnapshot,
		"Structured metrics:",
		JSON.stringify(summary, null, 2),
	].join("\n");
};

const generateNarrative = async (prompt: string, ctx: ExtensionCommandContext, args: string) => {
	const modelRef = resolveModelRef(ctx, args);
	if (!modelRef) return undefined;
	const model = ctx.modelRegistry.find(modelRef.provider, modelRef.id);
	if (!model) return undefined;
	const apiKey = await ctx.modelRegistry.getApiKey(model);
	if (!apiKey) return undefined;

	if (ctx.hasUI) {
		ctx.ui.setStatus("readiness-report", `AI review in progress (${modelRef.provider}/${modelRef.id})...`);
		ctx.ui.notify(`AI review: ${modelRef.provider}/${modelRef.id}`, "info");
		ctx.ui.setWidget("readiness-report-progress", [
			"AI review: running",
			`Model: ${modelRef.provider}/${modelRef.id}`,
			`Prompt size: ${prompt.length.toLocaleString()} chars`,
		]);
	}

	const messages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: prompt }],
			timestamp: Date.now(),
		},
	];

	const response = await complete(model, { messages }, { apiKey, reasoningEffort: "medium" });
	const narrative = response.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();

	if (ctx.hasUI) {
		ctx.ui.setStatus("readiness-report", "AI review completed");
	}

	if (!narrative) return undefined;
	return { narrative, model: modelRef };
};

const buildMarkdownReport = (report: Report, narrative?: string) => {
	const levelLabels: Record<number, string> = {
		1: "Functional",
		2: "Documented",
		3: "Standardized",
		4: "Optimized",
		5: "Autonomous",
	};

	const lines: string[] = [];
	lines.push(`# Readiness Report — ${report.repoName}`);
	lines.push("");
	lines.push(`Generated: ${report.generatedAt}`);
	if (report.model) {
		lines.push(`Model: ${report.model.provider}/${report.model.id}`);
	}
	lines.push("");
	lines.push("## Overview");
	lines.push(`- Level Achieved: **${report.maturity.levelAchieved} - ${levelLabels[report.maturity.levelAchieved]}**`);
	lines.push(`- Score: **${report.maturity.score}%** (${report.maturity.checksPassed}/${report.maturity.checksTotal} checks)`);
	lines.push(`- Languages: ${report.languages.join(", ") || "Unknown"}`);
	lines.push(`- Applications: ${report.apps.length}`);
	lines.push("");

	if (narrative) {
		lines.push("## Narrative Summary");
		lines.push(narrative);
		lines.push("");
	}

	lines.push("## Understanding the Output");
	lines.push("Scores are shown as numerator/denominator (apps passing / apps evaluated). The report includes Level Achieved, Applications Discovered, Criteria Results, and Action Items.");
	lines.push("");

	lines.push("## Action Items");
	if (report.actionItems.length === 0) {
		lines.push("- All criteria passed.");
	} else {
		for (const item of report.actionItems) {
			lines.push(`- **Level ${item.level}** — ${item.title}: ${item.recommendation}`);
		}
	}
	lines.push("");

	lines.push("## Applications Discovered");
	if (report.apps.length === 0) {
		lines.push("- None detected");
	} else {
		for (const app of report.apps) {
			lines.push(`- **${app.relativePath}** (${app.type}) — ${app.description ?? "No description"}`);
		}
	}
	lines.push("");

	lines.push("## Level Analytics");
	lines.push("| Level | Criteria Passed | Pass Rate |");
	lines.push("| --- | --- | --- |");
	for (const level of report.maturity.levelScores) {
		lines.push(`| ${level.level} - ${levelLabels[level.level]} | ${level.passed}/${level.total} | ${Math.round(level.passRate * 100)}% |`);
	}
	lines.push("");

	lines.push("## Pass Rate by Category");
	lines.push("| Category | Passed | Pass Rate |");
	lines.push("| --- | --- | --- |");
	for (const category of report.categories) {
		const percent = category.passRate === null ? "N/A" : `${Math.round(category.passRate * 100)}%`;
		lines.push(`| ${category.name} | ${category.passed}/${category.total} | ${percent} |`);
	}
	lines.push("");

	lines.push("## Level Over Time");
	if (report.history.length === 0) {
		lines.push("- No historical reports yet.");
	} else {
		for (const entry of report.history) {
			lines.push(`- ${entry.generatedAt}: Level ${entry.level} (${entry.score}%)`);
		}
	}
	lines.push("");

	lines.push("## Criteria Results");
	lines.push("| Category | Tier | Criterion | Score | Status |");
	lines.push("| --- | --- | --- | --- | --- |");
	for (const item of report.criteria) {
		const status = item.applicable ? (item.passed ? "Passed" : "Needs Work") : "N/A";
		lines.push(`| ${item.category} | ${item.tier} | ${item.title} | ${formatScore(item.numerator, item.denominator)} | ${status} |`);
	}
	lines.push("");
	lines.push("## Viewing Historical Reports");
	lines.push("Reports are saved under .pi/reports so you can compare readiness over time.");
	lines.push("");
	lines.push("## AI Prompt (Repo Snapshot)");
	lines.push(report.aiPrompt ?? "No AI prompt generated.");
	lines.push("");
	lines.push("## Remediation (Coming Soon)");
	lines.push("Future versions will offer automated fixes for failing criteria.");
	lines.push("");
	lines.push(`HTML report: ${report.paths.html}`);
	lines.push(`Markdown report: ${report.paths.md}`);
	lines.push(`JSON report: ${report.paths.json}`);
	return lines.join("\n");
};

const formatReportText = (report: Report) => {
	const lines: string[] = [];
	lines.push(`Readiness Report — ${report.repoName}`);
	if (report.model) {
		lines.push(`Model: ${report.model.provider}/${report.model.id}`);
	}
	lines.push("");
	lines.push("Level Achieved:");
	lines.push(`- ${report.maturity.levelAchieved}`);
	lines.push("");
	lines.push("Applications Discovered:");
	if (report.apps.length === 0) {
		lines.push("- None detected");
	} else {
		for (const app of report.apps) {
			lines.push(`- ${app.relativePath} (${app.type}) — ${app.description ?? "No description"}`);
		}
	}
	lines.push("");
	lines.push("Criteria Results:");
	for (const item of report.criteria) {
		const status = item.applicable ? (item.passed ? "✓" : "✗") : "N/A";
		lines.push(`- [${item.category}] ${item.tier} ${item.title}: ${formatScore(item.numerator, item.denominator)} ${status}`);
	}
	lines.push("(Score = numerator/denominator where numerator is apps passing; denominator is apps evaluated)");
	lines.push("");
	lines.push("Pass Rate by Category:");
	for (const category of report.categories) {
		const percent = category.passRate === null ? "N/A" : `${Math.round(category.passRate * 100)}%`;
		lines.push(`- ${category.name}: ${category.passed}/${category.total} (${percent})`);
	}
	lines.push("");
	lines.push("Level Over Time:");
	if (report.history.length === 0) {
		lines.push("- No historical reports yet.");
	} else {
		for (const entry of report.history) {
			lines.push(`- ${entry.generatedAt}: Level ${entry.level} (${entry.score}%)`);
		}
	}
	lines.push("");
	lines.push("Action Items:");
	for (const item of report.actionItems) {
		lines.push(`- [L${item.level}] ${item.title}: ${item.recommendation}`);
	}
	if (report.actionItems.length === 0) {
		lines.push("- All criteria passed.");
	}
	lines.push("");
	lines.push(`Score: ${report.maturity.score}% (${report.maturity.checksPassed}/${report.maturity.checksTotal} checks)`);
	lines.push(`Languages: ${report.languages.join(", ") || "Unknown"}`);
	lines.push("");
	lines.push(`HTML report: ${report.paths.html}`);
	lines.push(`Markdown report: ${report.paths.md}`);
	lines.push(`JSON report: ${report.paths.json}`);
	return lines.join("\n");
};

const buildReport = async (pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<Report> => {
	const setStatus = (message: string) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus("readiness-report", message);
		}
	};

	const setProgress = (lines: string[]) => {
		if (ctx.hasUI) {
			ctx.ui.setWidget("readiness-report-progress", lines);
		}
	};

	setStatus("Resolving repository root...");
	const repoRoot = await getRepoRoot(pi, ctx);
	const repoName = path.basename(repoRoot);

	setStatus("Detecting languages...");
	const languages = detectLanguages(repoRoot);
	setProgress([`Languages: ${languages.length ? languages.join(", ") : "Unknown"}`]);

	setStatus("Discovering applications...");
	const apps = discoverApps(repoRoot);
	setProgress([
		`Languages: ${languages.length ? languages.join(", ") : "Unknown"}`,
		`Apps discovered: ${apps.length}`,
	]);

	setStatus("Scanning repository files...");
	const files = getRepoFiles(repoRoot);
	const workflows = getWorkflowFiles(repoRoot);
	const readme = readText(path.join(repoRoot, "README.md"));

	setStatus("Building repo snapshot for AI review...");
	const repoSnapshot = buildRepoSnapshot(repoRoot);
	setProgress([
		`Languages: ${languages.length ? languages.join(", ") : "Unknown"}`,
		`Apps discovered: ${apps.length}`,
		`Snapshot size: ${repoSnapshot.length.toLocaleString()} chars`,
	]);

	const repoContext: RepoContext = {
		root: repoRoot,
		repoName,
		languages,
		apps,
		files,
		workflows,
		readme,
	};

	setStatus("Evaluating criteria...");
	const criteria = buildCriteria();
	const results = evaluateCriteria(criteria, repoContext);
	const maturity = computeMaturity(results);
	const actionItems = buildActionItems(results);
	setProgress([
		`Languages: ${languages.length ? languages.join(", ") : "Unknown"}`,
		`Apps discovered: ${apps.length}`,
		`Criteria evaluated: ${results.length}`,
	]);

	const generatedAt = new Date().toISOString();
	const timestamp = generatedAt.replace(/[:.]/g, "-");
	const reportDir = path.join(repoRoot, ".pi", "reports", `readiness-report-${timestamp}`);
	fs.mkdirSync(reportDir, { recursive: true });
	const htmlPath = path.join(reportDir, "readiness-report.html");
	const jsonPath = path.join(reportDir, "readiness-report.json");
	const mdPath = path.join(reportDir, "readiness-report.md");

	const categories = computeCategoryStats(results);
	const history = loadHistory(repoRoot);
	history.push({ generatedAt, level: maturity.levelAchieved, score: maturity.score });

	const report: Report = {
		generatedAt,
		repoRoot,
		repoName,
		languages,
		apps,
		maturity,
		categories,
		history,
		criteria: results,
		actionItems,
		paths: { html: htmlPath, json: jsonPath, md: mdPath },
	};

	setStatus("Preparing AI prompt...");
	const prompt = buildNarrativePrompt(report, repoSnapshot);
	report.aiPrompt = prompt;

	setStatus("Running AI review... (if model available)");
	const narrativeResult = await generateNarrative(prompt, ctx, args);
	if (narrativeResult?.model) {
		report.model = narrativeResult.model;
	}

	setStatus("Rendering reports...");
	const html = renderHtml(report);
	const markdown = buildMarkdownReport(report, narrativeResult?.narrative);
	fs.writeFileSync(htmlPath, html, "utf8");
	fs.writeFileSync(mdPath, markdown, "utf8");
	fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");

	return report;
};

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.model) {
			lastSelectedModel = { provider: ctx.model.provider, id: ctx.model.id };
		}
		if (ctx.hasUI) {
			ctx.ui.setStatus("readiness-report", "Extension loaded");
		}
	});

	pi.on("model_select", async (event) => {
		lastSelectedModel = { provider: event.model.provider, id: event.model.id };
	});

	pi.registerCommand("readiness-report", {
		description: "Generate a readiness report (HTML/MD/JSON) saved under .pi/",
		handler: async (args, ctx) => {
			if (ctx.hasUI) {
				ctx.ui.notify("Generating readiness report...", "info");
				ctx.ui.setStatus("readiness-report", "Scanning repository...");
			}

			try {
				const report = await buildReport(pi, ctx, args);
				const reportText = formatReportText(report);

				pi.sendMessage({
					customType: "readiness-report",
					content: reportText,
					display: true,
					details: report,
				});

				if (ctx.hasUI) {
					ctx.ui.setWidget("readiness-report", [
						`Level ${report.maturity.levelAchieved} • ${report.maturity.score}% score`,
						`Apps: ${report.apps.length} • Checks: ${report.maturity.checksPassed}/${report.maturity.checksTotal}`,
						`HTML: ${report.paths.html}`,
						`MD: ${report.paths.md}`,
					]);
					ctx.ui.notify(`Readiness report saved to ${report.paths.html}`, "success");
					ctx.ui.setStatus("readiness-report", "Report ready");
				}
			} catch (error) {
				if (ctx.hasUI) {
					ctx.ui.notify("Failed to generate readiness report", "error");
					ctx.ui.setStatus("readiness-report", "Error");
				}
				throw error;
			}
		},
	});
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  droparrConfigSchema,
  type Category,
  type DroparrConfig,
  type Instance,
} from "@droparr/shared";
import { zodToReadableErrors } from "./zod-helpers.js";

const EMPTY_CONFIG: DroparrConfig = {
  instances: [],
  categories: [],
  stagingDir: "",
};

/**
 * JSON-file config store. Reads at boot, writes atomically-ish on change.
 * Path precedence: DROPARR_CONFIG env var → ./data/config.json
 */
export class ConfigStore {
  private config: DroparrConfig;
  private readonly path: string;

  private constructor(path: string, config: DroparrConfig) {
    this.path = path;
    this.config = config;
  }

  static async load(path?: string): Promise<ConfigStore> {
    const filePath =
      path ?? process.env.DROPARR_CONFIG ?? join(process.cwd(), "data", "config.json");
    try {
      const raw = await readFile(filePath, "utf-8");
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`Droparr config at ${filePath} is not valid JSON`);
      }
      const parsed = droparrConfigSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error(
          `Invalid Droparr config at ${filePath}: ${zodToReadableErrors(parsed.error).join("; ")}`,
        );
      }
      return new ConfigStore(filePath, parsed.data);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return new ConfigStore(filePath, structuredClone(EMPTY_CONFIG));
      }
      throw err;
    }
  }

  get(): DroparrConfig {
    return this.config;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.config, null, 2), "utf-8");
  }

  // --- Instances ---

  listInstances(): Instance[] {
    return this.config.instances;
  }

  getInstance(id: string): Instance | undefined {
    return this.config.instances.find((i) => i.id === id);
  }

  async addInstance(instance: Instance): Promise<Instance> {
    this.config.instances.push(instance);
    await this.save();
    return instance;
  }

  async updateInstance(
    id: string,
    patch: Partial<Omit<Instance, "id">>,
  ): Promise<Instance | undefined> {
    const idx = this.config.instances.findIndex((i) => i.id === id);
    if (idx === -1) return undefined;
    this.config.instances[idx] = { ...this.config.instances[idx], ...patch };
    await this.save();
    return this.config.instances[idx];
  }

  async removeInstance(id: string): Promise<boolean> {
    const before = this.config.instances.length;
    this.config.instances = this.config.instances.filter((i) => i.id !== id);
    // Also drop categories pointing at the removed instance.
    this.config.categories = this.config.categories.filter(
      (c) => c.instanceId !== id,
    );
    const removed = this.config.instances.length < before;
    if (removed) await this.save();
    return removed;
  }

  // --- Categories ---

  listCategories(): Category[] {
    return this.config.categories;
  }

  getCategory(id: string): Category | undefined {
    return this.config.categories.find((c) => c.id === id);
  }

  async addCategory(category: Category): Promise<Category> {
    this.config.categories.push(category);
    await this.save();
    return category;
  }

  async updateCategory(
    id: string,
    patch: Partial<Omit<Category, "id">>,
  ): Promise<Category | undefined> {
    const idx = this.config.categories.findIndex((c) => c.id === id);
    if (idx === -1) return undefined;
    this.config.categories[idx] = { ...this.config.categories[idx], ...patch };
    await this.save();
    return this.config.categories[idx];
  }

  async removeCategory(id: string): Promise<boolean> {
    const before = this.config.categories.length;
    this.config.categories = this.config.categories.filter((c) => c.id !== id);
    const removed = this.config.categories.length < before;
    if (removed) await this.save();
    return removed;
  }

  // --- Settings ---

  async updateSettings(patch: {
    stagingDir?: string;
    jellyfin?: DroparrConfig["jellyfin"];
    llm?: DroparrConfig["llm"];
  }): Promise<DroparrConfig> {
    this.config = { ...this.config, ...patch };
    await this.save();
    return this.config;
  }

  /** Replace the whole configuration (settings import). */
  async replace(config: DroparrConfig): Promise<void> {
    this.config = config;
    await this.save();
  }
}

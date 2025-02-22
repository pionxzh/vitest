export interface DepsHandlingOptions {
  external?: (string | RegExp)[]
  inline?: (string | RegExp)[]
  /**
   * Try to guess the CJS version of a package when it's invalid ESM
   * @default true
   */
  fallbackCJS?: boolean
}

export interface FetchResult {
  code?: string
  externalize?: string
}

export type FetchFunction = (id: string) => Promise<FetchResult>
export type ResolveIdFunction = (id: string, importer?: string) => Promise<ViteNodeResolveId | null>

export interface ModuleCache {
  promise?: Promise<any>
  exports?: any
  code?: string
}

export interface ViteNodeRunnerOptions {
  fetchModule: FetchFunction
  resolveId: ResolveIdFunction
  root: string
  base?: string
  moduleCache?: Map<string, ModuleCache>
  interopDefault?: boolean
  requestStubs?: Record<string, any>
}

export interface ViteNodeResolveId {
  external?: boolean | 'absolute' | 'relative'
  id: string
  meta?: Record<string, any> | null
  moduleSideEffects?: boolean | 'no-treeshake' | null
  syntheticNamedExports?: boolean | string | null
}

export interface ViteNodeServerOptions {
  /**
   * Inject inline sourcemap to modules
   * @default true
   */
  sourcemap?: boolean
  /**
   * Deps handling
   */
  deps?: DepsHandlingOptions
  /**
   * Tranform method for modules
   */
  transformMode?: {
    ssr?: RegExp[]
    web?: RegExp[]
  }
}

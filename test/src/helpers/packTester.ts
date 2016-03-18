import { copy, emptyDir, remove, writeJson, readJson } from "fs-extra-p"
import * as assertThat from "should/as-function"
import * as path from "path"
import { parse as parsePlist } from "plist"
import { CSC_LINK, CSC_KEY_PASSWORD } from "./codeSignData"
import { expectedLinuxContents } from "./expectedContents"
import { readText } from "out/promisifed-fs"
import { Packager, PackagerOptions, Platform, getProductName } from "out"
import { normalizePlatforms } from "out/packager"
import { exec } from "out/util"
import pathSorter = require("path-sort")
import { tmpdir } from "os"

//noinspection JSUnusedLocalSymbols
const __awaiter = require("out/awaiter")

const tmpDirPrefix = "electron-builder-test-" + process.pid + "-"
let tmpDirCounter = 0

export async function assertPack(fixtureName: string,
                                packagerOptions: PackagerOptions,
                                tempDirCreated?: (projectDir: string) => Promise<any>,
                                packed?: (projectDir: string) => Promise<any>): Promise<void> {
  const useTempDir = tempDirCreated != null || (packagerOptions != null && packagerOptions.target != null)

  let projectDir = path.join(__dirname, "..", "..", "fixtures", fixtureName)
  // const isDoNotUseTempDir = platform === "darwin"
  const customTmpDir = process.env.TEST_APP_TMP_DIR
  if (useTempDir) {
    // non-osx test uses the same dir as osx test, but we cannot share node_modules (because tests executed in parallel)
    const dir = customTmpDir == null ? path.join(tmpdir(), tmpDirPrefix + fixtureName + "-" + tmpDirCounter++) : path.resolve(customTmpDir)
    if (customTmpDir != null) {
      console.log("Custom temp dir used: %s", customTmpDir)
    }
    await emptyDir(dir)
    await copy(projectDir, dir, {
      filter: it => {
        const basename = path.basename(it)
        return basename !== "dist" && basename !== "node_modules" && basename[0] !== "."
      }
    })
    projectDir = dir
  }

  try {
    if (tempDirCreated != null) {
      await tempDirCreated(projectDir)
    }

    await packAndCheck(projectDir, Object.assign({
      projectDir: projectDir,
      cscLink: CSC_LINK,
      cscKeyPassword: CSC_KEY_PASSWORD,
      dist: true,
    }, packagerOptions))

    if (packed != null) {
      await packed(projectDir)
    }
  }
  finally {
    if (useTempDir && customTmpDir == null) {
      try {
        await remove(projectDir)
      }
      catch (e) {
        console.warn("Cannot delete temporary directory " + projectDir + ": " + (e.stack || e))
      }
    }
  }
}

async function packAndCheck(projectDir: string, packagerOptions: PackagerOptions): Promise<void> {
  const packager = new Packager(packagerOptions)

  const artifacts: Map<Platform, Array<string>> = new Map()
  packager.artifactCreated((file, platform) => {
    assertThat(path.isAbsolute(file)).true()
    let list = artifacts.get(platform)
    if (list == null) {
      list = []
      artifacts.set(platform, list)
    }
    list.push(file)
  })

  await packager.build()

  if (!packagerOptions.dist) {
    return
  }

  for (let key of artifacts.keys()) {
    artifacts.set(key, pathSorter(artifacts.get(key)))
  }

  const expandedPlatforms = normalizePlatforms(packagerOptions.platform)
  if (expandedPlatforms.includes("darwin")) {
    await checkOsXResult(packager, artifacts.get(Platform.OSX))
  }
  else if (expandedPlatforms.includes("linux")) {
    const productName = getProductName(packager.metadata, packager.devMetadata)
    const expectedContents = expectedLinuxContents.map(it => {
      if (it === "/opt/TestApp/TestApp") {
        return "/opt/" + productName + "/" + productName
      }
      else if (it === "/usr/share/applications/TestApp.desktop") {
        return `/usr/share/applications/${productName}.desktop`
      }
      else {
        return it.replace(new RegExp("/opt/TestApp/", "g"), `/opt/${productName}/`)
      }
    })

    // console.log(JSON.stringify(await getContents(projectDir + "/dist/TestApp-1.0.0-amd64.deb", productName), null, 2))
    // console.log(JSON.stringify(await getContents(projectDir + "/dist/TestApp-1.0.0-i386.deb", productName), null, 2))

    assertThat(await getContents(projectDir + "/dist/TestApp-1.0.0-amd64.deb", productName)).deepEqual(expectedContents)
    if (packagerOptions == null || packagerOptions.arch === null || packagerOptions.arch === "ia32") {
      assertThat(await getContents(projectDir + "/dist/TestApp-1.0.0-i386.deb", productName)).deepEqual(expectedContents)
    }
  }
  else if (expandedPlatforms.includes("win32") && (packagerOptions == null || packagerOptions.target == null)) {
    await checkWindowsResult(packagerOptions, artifacts.get(Platform.WINDOWS))
  }
}

async function checkOsXResult(packager: Packager, artifacts: Array<string>) {
  const productName = getProductName(packager.metadata, packager.devMetadata)
  const packedAppDir = path.join(path.dirname(artifacts[0]), (productName || packager.metadata.name) + ".app")
  const info = parsePlist(await readText(path.join(packedAppDir, "Contents", "Info.plist")))
  assertThat(info).has.properties({
    CFBundleDisplayName: productName,
    CFBundleIdentifier: "your.id",
    LSApplicationCategoryType: "your.app.category.type",
    CFBundleVersion: "1.0.0" + "." + (process.env.TRAVIS_BUILD_NUMBER || process.env.CIRCLE_BUILD_NUM)
  })

  const result = await exec("codesign", ["--verify", packedAppDir])
  assertThat(result[0].toString()).not.match(/is not signed at all/)

  assertThat(artifacts.map(it => path.basename((it))).sort()).deepEqual([
    "TestApp-1.0.0-mac.zip",
    "TestApp-1.0.0.dmg"
  ].sort())
}

async function checkWindowsResult(packagerOptions: PackagerOptions, artifacts: Array<string>) {
  const expected32 = [
    "RELEASES-ia32",
    "TestAppSetup-1.0.0-ia32.exe",
    "TestApp-1.0.0-ia32-full.nupkg",
  ]
  const expected64 = [
    "RELEASES",
    "TestAppSetup-1.0.0.exe",
    "TestApp-1.0.0-full.nupkg",
  ]
  const expected = packagerOptions != null && packagerOptions.arch === "x64" ? expected64 : expected32.concat(expected64)
  const filenames = artifacts.map(it => path.basename((it)))
  assertThat(filenames.slice().sort()).deepEqual(expected.sort())

  let i = filenames.indexOf("RELEASES-ia32")
  if (i !== -1) {
    assertThat((await readText(artifacts[i])).indexOf("ia32")).not.equal(-1)
  }
}

async function getContents(path: string, productName: string) {
  const result = await exec("dpkg", ["--contents", path])
  return pathSorter(result[0].toString()
    .split("\n")
    .map(it => it.length === 0 ? null : it.substring(it.indexOf(".") + 1))
    .filter(it => it != null && !(it.startsWith(`/opt/${productName}/locales/`) || it.startsWith(`/opt/${productName}/libgcrypt`)))
    )
}

export async function modifyPackageJson(projectDir: string, task: (data: any) => void, isApp: boolean = false): Promise<any> {
  const file = isApp ? path.join(projectDir, "app", "package.json") : path.join(projectDir, "package.json")
  const data = await readJson(file)
  task(data)
  return await writeJson(file, data)
}

export function platform(platform: string): PackagerOptions {
  return {
    platform: [platform]
  }
}
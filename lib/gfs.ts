import fs from "fs"
import path from "path"
import { randomBytes } from "crypto"
import { Readable } from "stream"
import { pb } from "./core"
import { drop } from "./errors"
import * as common from "./common"
import { highwayUpload } from "./internal"
import { FileElem } from "./message"

type Client = import("./client").Client

/** 共通属性 */
export interface GfsBaseStat {
	/** 文件或目录的id (目录以/开头) */
	fid: string
	/** 父目录id */
	pid: string
	name: string
	user_id: number
	create_time: number
	is_dir: boolean
}

/** 文件属性 */
export interface GfsFileStat extends GfsBaseStat {
	size: number
	busid: number
	md5: string
	sha1: string
	duration: number
	download_times: number
}

/** 目录属性 */
export interface GfsDirStat extends GfsBaseStat {
	file_count: number
}

export type GfsStat = GfsFileStat | GfsDirStat

function checkRsp(rsp: pb.Proto) {
	if (rsp[1] === 0) return
	drop(rsp[1], rsp[2])
}

/** 群文件系统 */
export class Gfs {

	constructor(private c: Client, public readonly gid: number) { }

	/** 获取使用空间和文件数 */
	async df() {
		const [a, b] = await Promise.all([(async()=>{
			const body = pb.encode({
				4: {
					1: this.gid,
					2: 3
				}
			})
			const payload = await this.c.sendOidb("OidbSvc.0x6d8_3", body)
			const rsp = pb.decode(payload)[4][4]
			const total = rsp[4], used = rsp[5], free = total - used
			return {
				total, used, free
			}
		})(),
		(async()=>{
			const body = pb.encode({
				3: {
					1: this.gid,
					2: 2
				}
			})
			const payload = await this.c.sendOidb("OidbSvc.0x6d8_2", body)
			const rsp = pb.decode(payload)[4][3]
			const file_count = rsp[4], max_file_count = rsp[6]
			return {
				file_count, max_file_count
			}
		})()])
		return Object.assign(a, b)
	}

	private async _resolve(fid: string) {
		const body = pb.encode({
			1: {
				1: this.gid,
				2: 0,
				4: String(fid)
			}
		})
		const payload = await this.c.sendOidb("OidbSvc.0x6d8_0", body)
		const rsp = pb.decode(payload)[4][1]
		if (rsp[1])
			drop(rsp[1], rsp[2])
		return genGfsFileStat(rsp[4])
	}

	/** 获取文件或目录属性 */
	async stat(fid: string) {
		try {
			return await this._resolve(fid)
		} catch (e) {
			const files = await this.dir("/")
			for (let file of files) {
				if (!file.is_dir)
					break
				if (file.fid === fid)
					return file
			}
			throw e
		}
	}

	/** 列出目录下的所有文件和目录 */
	async dir(pid = "/", start = 0, limit = 100) {
		const body = pb.encode({
			2: {
				1: this.gid,
				2: 1,
				3: String(pid),
				5: Number(limit) || 100,
				13: Number(start) || 0
			}
		})
		const payload = await this.c.sendOidb("OidbSvc.0x6d8_1", body)
		const rsp = pb.decode(payload)[4][2]
		checkRsp(rsp)
		const arr: GfsStat[] = []
		if (!rsp[5]) return arr
		const files = Array.isArray(rsp[5]) ? rsp[5] : [rsp[5]]
		for (let file of files) {
			if (file[3])
				arr.push(genGfsFileStat(file[3]))
			else if (file[2])
				arr.push(genGfsDirStat(file[2]))
		}
		return arr
	}
	/** dir的别名 */
	ls(pid = "/", start = 0, limit = 100) {
		return this.dir(pid, start, limit)
	}

	/** 创建目录(只能在根目录下创建) */
	async mkdir(name: string) {
		const body = pb.encode({
			1: {
				1: this.gid,
				2: 0,
				3: "/",
				4: String(name)
			}
		})
		const payload = await this.c.sendOidb("OidbSvc.0x6d7_0", body)
		const rsp = pb.decode(payload)[4][1]
		checkRsp(rsp)
		return genGfsDirStat(rsp[4])
	}

	/** 删除文件或目录(删除目录会删除下面的所有文件) */
	async rm(fid: string) {
		fid = String(fid)
		let rsp
		if (!fid.startsWith("/")) { //rm file
			const file = await this._resolve(fid)
			const body = pb.encode({
				4: {
					1: this.gid,
					2: 3,
					3: file.busid,
					4: file.pid,
					5: file.fid,
				}
			})
			const payload = await this.c.sendOidb("OidbSvc.0x6d6_3", body)
			rsp = pb.decode(payload)[4][4]
		} else { //rm dir
			const body = pb.encode({
				2: {
					1: this.gid,
					2: 1,
					3: String(fid)
				}
			})
			const payload = await this.c.sendOidb("OidbSvc.0x6d7_1", body)
			rsp = pb.decode(payload)[4][2]
		}
		checkRsp(rsp)
	}

	/** 重命名文件或目录 */
	async rename(fid: string, name: string) {
		fid = String(fid)
		let rsp
		if (!fid.startsWith("/")) { //rename file
			const file = await this._resolve(fid)
			const body = pb.encode({
				5: {
					1: this.gid,
					2: 4,
					3: file.busid,
					4: file.fid,
					5: file.pid,
					6: String(name)
				}
			})
			const payload = await this.c.sendOidb("OidbSvc.0x6d6_4", body)
			rsp = pb.decode(payload)[4][5]
			
		} else { //rename dir
			const body = pb.encode({
				3: {
					1: this.gid,
					2: 2,
					3: String(fid),
					4: String(name)
				}
			})
			const payload = await this.c.sendOidb("OidbSvc.0x6d7_2", body)
			rsp = pb.decode(payload)[4][3]
		}
		checkRsp(rsp)
	}

	/** 移动文件(所有目录必须在根目录下，因此无法移动目录) */
	async mv(fid: string, pid: string) {
		const file = await this._resolve(fid)
		const body = pb.encode({
			6: {
				1: this.gid,
				2: 5,
				3: file.busid,
				4: file.fid,
				5: file.pid,
				6: String(pid)
			}
		})
		const payload = await this.c.sendOidb("OidbSvc.0x6d6_5", body)
		const rsp = pb.decode(payload)[4][6]
		checkRsp(rsp)
	}

	private async _feed(fid: string, busid: number) {
		const body = pb.encode({
			5: {
				1: this.gid,
				2: 4,
				3: {
					1: busid,
					2: fid,
					3: randomBytes(4).readInt32BE(),
					5: 1,
				}
			}
		})
		const payload = await this.c.sendOidb("OidbSvc.0x6d9_4", body)
		let rsp = pb.decode(payload)[4][5]
		checkRsp(rsp)
		rsp = rsp[4]
		checkRsp(rsp)
		return await this._resolve(rsp[3])
	}

	/** 上传一个文件 */
	async upload(file: string | Buffer, pid = "/", name?: string, callback?: (percentage: string) => void) {
		let size, md5, sha1
		if (file instanceof Buffer) {
			if (!Buffer.isBuffer(file))
				file = Buffer.from(file)
			size = file.length
			md5 = common.md5(file), sha1 = common.sha(file)
			name = name ? String(name) : ("file" + md5.toString("hex"))
		} else {
			file = String(file)
			size = (await fs.promises.stat(file)).size
			;[md5, sha1] = await common.fileHash(file)
			name = name ? String(name) : path.basename(file)
		}
		const body = pb.encode({
			1: {
				1: this.gid,
				2: 0,
				3: 102,
				4: 5,
				5: String(pid),
				6: name,
				7: "/storage/emulated/0/Pictures/files/s/" + name,
				8: size,
				9: sha1,
				11: md5,
				15: 1,
			}
		})
		const payload = await this.c.sendOidb("OidbSvc.0x6d6_0", body)
		const rsp = pb.decode(payload)[4][1]
		checkRsp(rsp)
		if (!rsp[10]) {
			const ext = pb.encode({
				1: 100,
				2: 1,
				3: 0,
				100: {
					100: {
						1: rsp[6],
						100: this.c.uin,
						200: this.gid,
						400: this.gid,
					},
					200: {
						100: size,
						200: md5,
						300: sha1,
						600: rsp[7],
						700: rsp[9],
					},
					300: {
						100: 2,
						200: String(this.c.apk.subid),
						300: 2,
						400: "9e9c09dc",
						600: 4,
					},
					400: {
						100: name,
					},
					500: {
						200: {
							1: {
								1: 1,
								2: rsp[12]
							},
							2: rsp[14]
						}
					},
				}
			})
			await highwayUpload.call(
				this.c,
				Buffer.isBuffer(file) ? Readable.from(file, { objectMode: false }) : fs.createReadStream(String(file), { highWaterMark: 1024 * 256 }),
				{
					cmdid: 71, callback,
					md5, size, ext
				}
			)
		}
		return await this._feed(String(rsp[7]), rsp[6])
	}

	/** 获取文件下载地址 */
	async download(fid: string) {
		const file = await this._resolve(fid)
		const body = pb.encode({
			3: {
				1: this.gid,
				2: 2,
				3: file.busid,
				4: file.fid,
			}
		})
		const payload = await this.c.sendOidb("OidbSvc.0x6d6_2", body)
		const rsp = pb.decode(payload)[4][3]
		checkRsp(rsp)
		return {
			name: file.name,
			url: `http://${rsp[4]}/ftn_handler/${rsp[6].toHex()}/?fname=${file.name}`,
			size: file.size,
			md5: file.md5,
			duration: file.duration,
			fid: file.fid,
		} as Omit<FileElem, "type"> & { url: string }
	}
}

function genGfsDirStat(file: pb.Proto): GfsDirStat {
	return {
		fid: String(file[1]),
		pid: String(file[2]),
		name: String(file[3]),
		create_time: file[4],
		user_id: file[6],
		file_count: file[8] || 0,
		is_dir: true,
	}
}

function genGfsFileStat(file: pb.Proto): GfsFileStat {
	const stat = {
		fid: String(file[1]),
		pid: String(file[16]),
		name: String(file[2]),
		busid: file[4],
		size: file[5],
		md5: file[12].toHex(),
		sha1: file[10].toHex(),
		create_time: file[6],
		duration: file[7],
		user_id: file[15],
		download_times: file[9],
		is_dir: false,
	}
	if (stat.fid.startsWith("/"))
		stat.fid = stat.fid.slice(1)
	return stat
}

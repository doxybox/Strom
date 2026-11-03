"""Lager app/nettselskaper.json fra fri-nettleie (https://github.com/kraftsystemet/fri-nettleie, CC BY 4.0)."""
import datetime as dt, glob, json, os, sys, yaml

repo = sys.argv[1]
out = sys.argv[2]
esett = json.load(open(f"{repo}/referanse-data/esett/metering_grid_areas.json"))
owners = json.load(open(f"{repo}/referanse-data/elhub/grid_owners.json"))
counts = {x["gln"]: x["mp_count"] for x in json.load(open(f"{repo}/referanse-data/elhub/grid_owner_mp_count.json"))}
fylker = {}
for x in json.load(open(f"{repo}/referanse-data/nve/konsesjonar_fylke.json")):
    fylker.setdefault(x["organisasjonsnr"], set()).add(x["fylke"])
orgnr = {x["gln"]: x.get("organisationNumber") for x in owners}

def zones(glns):
    z = {x["mba"] for x in esett if x["dsoCode"] in glns and x["mgaType"] == "DISTRIBUTION"}
    if not z:
        z = {x["mba"] for x in esett if x["dsoCode"] in glns and x["mgaType"] in ("REGIONAL", "PRODUCTION")}
    return sorted(z)

def norm(v):
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()[:10]
    if isinstance(v, dict):
        return {k: norm(x) for k, x in v.items()}
    if isinstance(v, list):
        return [norm(x) for x in v]
    return v

res = []
for f in sorted(glob.glob(f"{repo}/tariffer/*.yml")):
    d = yaml.safe_load(open(f, encoding="utf-8"))
    glns = [str(g) for g in d.get("gln", [])]
    tar = [norm(t) for t in d.get("tariffer", []) if "husholdning" in (t.get("kundegrupper") or [])]
    if not tar:
        continue
    fy = set()
    for g in glns:
        fy |= fylker.get(orgnr.get(g), set())
    res.append({
        "id": os.path.basename(f)[:-4],
        "navn": d["netteier"].strip(),
        "soner": zones(glns),
        "fylker": sorted(x.strip() for x in fy),
        "kunder": sum(counts.get(g, 0) for g in glns),
        "sist_oppdatert": norm(d.get("sist_oppdatert")),
        "kilder": d.get("kilder", [])[:3],
        "tariffer": tar,
    })
res.sort(key=lambda x: x["navn"].lower())
json.dump({"kilde": "fri-nettleie (kraftsystemet.no), CC BY 4.0", "generert": dt.date.today().isoformat(),
           "selskaper": res}, open(out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(len(res), "selskaper")
for r in res:
    if not r["soner"]:
        print("mangler sone:", r["id"], r["navn"])

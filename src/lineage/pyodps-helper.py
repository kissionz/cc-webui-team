#!/usr/bin/env python3
"""Small NDJSON bridge between the Node service and the official PyODPS SDK."""

from __future__ import annotations

import datetime
import decimal
import json
import sys
from typing import Any


def emit(payload: dict[str, Any], stream: Any = sys.stdout) -> None:
    stream.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    stream.flush()


def fail(code: str, message: str, detail: str = "") -> None:
    emit({"type": "error", "code": code, "message": message, "detail": detail}, sys.stderr)


def text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, (datetime.date, datetime.datetime, datetime.time, decimal.Decimal)):
        return str(value)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)
    return str(value)


def main() -> int:
    try:
        from odps import ODPS, __version__ as sdk_version, options
    except ModuleNotFoundError:
        fail(
            "PYODPS_NOT_INSTALLED",
            "当前 Python 环境未安装 PyODPS。",
            "请执行：python -m pip install pyodps==0.13.0",
        )
        return 78
    except Exception as error:  # pragma: no cover - depends on the host Python installation
        fail("PYODPS_IMPORT_FAILED", "PyODPS 加载失败。", str(error))
        return 78

    try:
        request = json.load(sys.stdin)
        required = ("accessKeyId", "accessKeySecret", "endpoint", "project", "sql", "fields")
        if not isinstance(request, dict) or any(key not in request for key in required):
            raise ValueError("请求缺少必要字段。")
        fields = request["fields"]
        if not isinstance(fields, list) or not fields or not all(isinstance(item, str) and item for item in fields):
            raise ValueError("fields 必须是非空字符串数组。")

        options.tunnel.limit_instance_tunnel = False
        client = ODPS(
            request["accessKeyId"],
            request["accessKeySecret"],
            request["project"],
            endpoint=request["endpoint"],
        )
        instance = client.execute_sql(
            request["sql"],
            hints={"odps.namespace.schema": "true"},
        )
        emit({
            "type": "meta",
            "pythonVersion": sys.version.split()[0],
            "sdkVersion": sdk_version,
            "instanceId": getattr(instance, "id", ""),
        })
        if request.get("validateOnly"):
            instance.wait_for_success()
            emit({"type": "done", "rows": 0})
            return 0

        count = 0
        with instance.open_reader(tunnel=True, limit=False) as reader:
            for record in reader:
                values = {field: text(record[index]) for index, field in enumerate(fields)}
                emit({"type": "row", "value": values})
                count += 1
        emit({"type": "done", "rows": count})
        return 0
    except Exception as error:
        name = type(error).__name__
        message = str(error) or name
        code = "MAXCOMPUTE_QUERY_FAILED"
        lowered = message.lower()
        if "permission" in lowered or "access denied" in lowered or "unauthorized" in lowered:
            code = "MAXCOMPUTE_PERMISSION_DENIED"
        elif "tunnel" in lowered:
            code = "MAXCOMPUTE_TUNNEL_FAILED"
        fail(code, "MaxCompute 查询失败。", f"{name}: {message}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

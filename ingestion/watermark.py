"""The pipeline's bookmark: the newest :updated_at that's safely stored in S3."""
import boto3

PARAM = "/heatwatch/311/watermark"
_ssm = boto3.client("ssm")  # created once at import - in Lambda this gets reused between warm runs


def get_watermark() -> str:
    return _ssm.get_parameter(Name=PARAM)["Parameter"]["Value"]


def set_watermark(value: str) -> None:
    # Overwrite=True: replace the sticky note, don't stack a new one on top
    _ssm.put_parameter(Name=PARAM, Value=value, Type="String", Overwrite=True)
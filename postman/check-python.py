from ggate.core.client import Client
from ggate.core.config import Config

client = Client(Config.from_values(agent_name="Contract test", team="SDK validation", console_url="http://127.0.0.1:4918/console", api_key="local-test-only"))
decision = client.scan_prompt("Harmless fixture request")
assert decision.verdict == "pass" and not decision.fail_open
assert decision.pipeline_status["errors"][0]["code"] == "attachment_scan_incomplete"
assert decision.document_intelligence.file_classification["status"] == "unavailable"
assert decision.document_intelligence.taxonomy.topic.resolution["uncertain"] is True
assert client.flush()
print("Python SDK HTTP contract smoke passed")

"""Removal-request identifiers come from private KB configuration, never from source."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from hardissoft_kb import catalog, privacy

CONFIG_NAME = 'privacy-request-identifiers.json'


class RequestIdentifierConfigurationTests(unittest.TestCase):
    def _root(self, content):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        (root / 'config').mkdir()
        if content is not None:
            (root / 'config' / CONFIG_NAME).write_text(content, encoding='utf-8')
        return root

    def test_configured_identifiers_are_redacted_as_whole_words_in_any_case(self):
        root = self._root(json.dumps(['Example Person', 'ExampleCo']))
        with patch.object(catalog, 'ROOT', root):
            result = privacy.redact('Ask example person at EXAMPLECO; Example Personnel stays.')
        self.assertEqual(result['text'], 'Ask [REDACTED:identifier] at [REDACTED:identifier]; Example Personnel stays.')

    def test_empty_configuration_declares_that_no_request_applies(self):
        root = self._root('[]')
        with patch.object(catalog, 'ROOT', root):
            self.assertEqual(privacy.redact('Ask Example Person.')['text'], 'Ask Example Person.')

    def test_missing_or_malformed_configuration_fails_closed(self):
        cases = (
            (None, FileNotFoundError),
            ('{"name": "Example Person"}', ValueError),
            ('["Example Person", " "]', ValueError),
            ('not json', ValueError),
        )
        for content, error in cases:
            with self.subTest(content=content):
                root = self._root(content)
                with patch.object(catalog, 'ROOT', root), self.assertRaises(error):
                    privacy.redact('Example Person')


if __name__ == '__main__':
    unittest.main()

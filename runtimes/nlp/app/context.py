"""Conservative assertion detection. Unknown context is never positive by default."""
import re

def assertion(text: str, start: int, end: int) -> str:
    prefix = re.split(r'[.;!?]|\b(?:but|however|yet)\b', text[:start], flags=re.I)[-1].lower()
    suffix = re.split(r'[.;!?]|\b(?:but|however|yet)\b', text[end:], flags=re.I)[0].lower()
    before = ' '.join(re.findall(r"[a-z]+(?:'[a-z]+)?", prefix)[-8:])
    after = ' '.join(re.findall(r"[a-z]+(?:'[a-z]+)?", suffix)[:5])
    if re.search(r'\b(?:mother|father|sister|brother|child|son|daughter|family)\b', before):
        return 'other_person'
    if re.search(r'\b(?:maybe|possibly|perhaps|unsure|uncertain|might|not sure)\b', before):
        return 'uncertain'
    if re.search(r'\b(?:used to|history of|previously|last year|years ago|resolved)\b', before+' '+after):
        return 'historical'
    if re.search(r"\b(?:no|not|without|deny|denies|denied|never)\b", before):
        return 'denied'
    if re.search(r'\b(?:absent|denied|not present)\b', after):
        return 'denied'
    if re.search(r'\b(?:if|unless|whether|hypothetical|worried about)\b', before):
        return 'unresolved'
    return 'present'

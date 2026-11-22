_PROMOS = {}


def get(code):
    return _PROMOS.get(code.upper())

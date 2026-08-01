function TreeNode({ node, depth, selected, onSelect }) {
  if (node.children) {
    return (
      <li className="tree-folder">
        <span className="tree-folder-label" style={{ paddingLeft: `${depth * 12}px` }}>
          {node.label}
        </span>
        <ul>
          {node.children.map(child => (
            <TreeNode key={child.id} node={child} depth={depth + 1} selected={selected} onSelect={onSelect} />
          ))}
        </ul>
      </li>
    )
  }

  return (
    <li
      className={`tree-doc ${selected?.id === node.id ? 'active' : ''}`}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
      onClick={() => onSelect(node)}
    >
      <span className="tree-doc-title">{node.title}</span>
    </li>
  )
}

export default function FileExplorer({ tree, selected, onSelect }) {
  return (
    <nav className="file-explorer">
      <ul>
        {tree.map(node => (
          <TreeNode key={node.id} node={node} depth={0} selected={selected} onSelect={onSelect} />
        ))}
      </ul>
    </nav>
  )
}
